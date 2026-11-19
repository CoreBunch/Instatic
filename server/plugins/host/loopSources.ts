/**
 * Plugin loop sources as the editor sees them.
 *
 * The publish paths reach a plugin source through `loopSourceRegistry`, whose
 * shim runs the plugin's `fetch` in its worker. The editor runs in another
 * process and needs two more things: the list of sources plugins registered
 * (so the Loop module's Source picker can offer them), and sample items for
 * the canvas.
 *
 * Sample items come from the plugin's `preview()` and never from `fetch()`.
 * A source's `fetch` may hold data the person editing a page has no right to
 * read (every subscription, every customer); `preview` is sample data by
 * contract, and it is told nothing about a visitor or a member.
 *
 * A preview runs in the plugin's one worker, so it competes with the
 * plugin's real work, and anyone who can open the editor can ask for one.
 * The host therefore keeps previews few and cheap:
 *
 *   - `preview()` may run for one second (`LOOP_PREVIEW_TIMEOUT_MS`);
 *   - one preview per plugin is with the worker at a time. The same question
 *     asked again joins the run already waiting or under way; a different
 *     one waits in a line of at most `MAX_WAITING_PREVIEWS`, and past that
 *     is refused as busy without reaching the worker;
 *   - each user may start only so many previews per plugin per minute;
 *   - a preview that does not answer fails alone (`onTimeout: 'reject'`): it
 *     is not a worker fault and nothing is recorded against the plugin.
 */

import {
  LOOP_PREVIEW_MAX_BYTES,
  LoopSourcePreviewItemsSchema,
  loopSourceRegistry,
  type LoopItem,
  type RemoteLoopSource,
} from '@core/loops'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import { RateLimiter } from '../../auth/rateLimit'
import { hostPlugins } from './registry'
import { runLoopPreviewInWorker } from './rpc'

/** Every loop source a running plugin has registered, with its owner. */
export function listPluginLoopSources(): RemoteLoopSource[] {
  const sources: RemoteLoopSource[] = []
  for (const entry of hostPlugins.values()) {
    for (const { sourceId, pluginId } of entry.loopSources) {
      const source = loopSourceRegistry.get(sourceId)
      if (!source) continue
      sources.push({
        id: source.id,
        label: source.label,
        ...(source.description !== undefined ? { description: source.description } : {}),
        filterSchema: source.filterSchema,
        orderByOptions: source.orderByOptions,
        fields: source.fields,
        ...(source.requestDependent ? { requestDependent: true } : {}),
        ...(source.perVisitor ? { perVisitor: true } : {}),
        provider: { pluginId, pluginName: entry.manifest.name },
      })
    }
  }
  return sources
}

export type PluginLoopPreview =
  | { status: 'ok'; items: LoopItem[] }
  | { status: 'unknown-source' }
  /** Too many previews from this user, or too many waiting for this plugin. */
  | { status: 'busy'; retryAfterMs: number }
  | { status: 'failed'; error: string }

/**
 * The editor asks once per source, filters and limit and again only when a
 * filter settles on a new value, so thirty a minute is far above honest use.
 */
const previewRateLimit = new RateLimiter({ limit: 30, windowMs: 60_000 })

/** Previews that may wait behind the one a plugin's worker is running. */
const MAX_WAITING_PREVIEWS = 3

/** What a refused asker is told to wait: a full line clears in about this long. */
const BUSY_RETRY_AFTER_MS = 2_000

/** How deep a field value may nest. A list of objects of lists is depth 3. */
const MAX_FIELD_DEPTH = 6

interface PluginPreviewLine {
  /** Settles when the last preview handed to this plugin has finished. */
  tail: Promise<unknown>
  /** Previews not yet finished, the running one included, by question. */
  pending: Map<string, Promise<PluginLoopPreview>>
}

const previewLines = new Map<string, PluginPreviewLine>()

function owningPluginId(sourceId: string): string | null {
  for (const entry of hostPlugins.values()) {
    if (entry.loopSources.some((source) => source.sourceId === sourceId)) return entry.manifest.id
  }
  return null
}

function withinDepth(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== 'object') return true
  if (depth === 0) return false
  return Object.values(value).every((child) => withinDepth(child, depth - 1))
}

async function runPreview(
  pluginId: string,
  sourceId: string,
  options: { filters: Record<string, unknown>; limit: number },
): Promise<PluginLoopPreview> {
  let result: Awaited<ReturnType<typeof runLoopPreviewInWorker>>
  try {
    result = await runLoopPreviewInWorker(pluginId, sourceId, {
      filters: options.filters,
      limit: options.limit,
    })
  } catch (err) {
    console.error(`[plugin:${pluginId}] loop source "${sourceId}" preview failed:`, err)
    return { status: 'failed', error: 'The plugin did not answer.' }
  }
  if (!result.ok) {
    return { status: 'failed', error: 'The plugin\'s preview() failed. The server log has the details.' }
  }

  const items = safeParseValue(LoopSourcePreviewItemsSchema, result.items.slice(0, options.limit))
  if (!items.ok) {
    return {
      status: 'failed',
      error: 'preview() must return items shaped { id: string, fields: { … } }.',
    }
  }
  if (!items.value.every((item) => withinDepth(item.fields, MAX_FIELD_DEPTH))) {
    return { status: 'failed', error: 'preview() returned field values nested too deeply.' }
  }
  if (Buffer.byteLength(JSON.stringify(items.value), 'utf8') > LOOP_PREVIEW_MAX_BYTES) {
    return { status: 'failed', error: 'preview() returned more data than a preview may carry.' }
  }
  return { status: 'ok', items: items.value }
}

/**
 * Ask a plugin source for sample items on behalf of `userId`. The plugin is
 * handed the loop's filters and a limit, nothing else. Its answer is checked
 * item by item and capped in count, depth and size before it leaves the host.
 */
export function previewPluginLoopSource(
  userId: string,
  sourceId: string,
  options: { filters: Record<string, unknown>; limit: number },
): Promise<PluginLoopPreview> {
  const pluginId = owningPluginId(sourceId)
  if (!pluginId) return Promise.resolve({ status: 'unknown-source' })

  let line = previewLines.get(pluginId)
  if (!line) {
    line = { tail: Promise.resolve(), pending: new Map() }
    previewLines.set(pluginId, line)
  }

  // The same question already waiting or being answered: share that answer.
  // It costs the plugin nothing more, so it is not counted against the asker.
  const key = JSON.stringify([sourceId, options.filters, options.limit])
  const shared = line.pending.get(key)
  if (shared) return shared

  // One running plus the line behind it. Past that the asker is told to come
  // back, and the worker never hears of it.
  if (line.pending.size > MAX_WAITING_PREVIEWS) {
    return Promise.resolve({ status: 'busy', retryAfterMs: BUSY_RETRY_AFTER_MS })
  }
  const allowed = previewRateLimit.consume(`${userId}:${pluginId}`)
  if (!allowed.ok) return Promise.resolve({ status: 'busy', retryAfterMs: allowed.retryAfterMs })

  const held = line
  const run = held.tail.then(() => runPreview(pluginId, sourceId, options))
  // `runPreview` never rejects, so the line never stalls on a failure.
  held.tail = run
  held.pending.set(key, run)
  void run.finally(() => {
    held.pending.delete(key)
    if (held.pending.size === 0 && previewLines.get(pluginId) === held) previewLines.delete(pluginId)
  })
  return run
}
