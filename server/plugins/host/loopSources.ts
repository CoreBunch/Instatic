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
 * The host therefore keeps previews few:
 *
 *   - one preview per plugin is with the worker at a time. The same question
 *     asked again joins the run already waiting or under way. A different one
 *     waits in a line of at most `MAX_WAITING_PREVIEWS`, where each user
 *     holds one place (their newer question takes the place of their older
 *     one); past that the asker is told the plugin is busy and the worker
 *     never hears of it;
 *   - each user may start only so many previews per plugin per minute;
 *   - a waiting preview is dropped if its plugin is no longer loaded when its
 *     turn comes, so a preview never starts a worker for a plugin that was
 *     disabled, removed or parked meanwhile.
 *
 * What this guarantees: previews that answer, however slowly within their
 * limit, cannot pile up in the worker until the host's reply deadline runs
 * out. What it does not change: a `preview()` that never returns is the
 * plugin's own code hanging, and is treated like any call into that plugin
 * that never returns (the worker is restarted and the crash counted). The VM
 * cuts `preview()` off after `LOOP_PREVIEW_TIMEOUT_MS` when nothing else is
 * running in that plugin's VM; with another call in flight the VM's
 * interrupt waits for the latest deadline among them.
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

interface WaitingPreview {
  key: string
  userId: string
  sourceId: string
  options: { filters: Record<string, unknown>; limit: number }
  answer: (preview: PluginLoopPreview) => void
}

interface PluginPreviewLine {
  /** Whether a preview is with the worker now. */
  running: boolean
  waiting: WaitingPreview[]
  /** Previews not yet answered, the running one included, by question. */
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
  // Checked in the same tick as the call below: sending to a plugin that is
  // not loaded would start a worker for it.
  if (owningPluginId(sourceId) !== pluginId) return { status: 'unknown-source' }
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

/** Hand the plugin its next waiting preview, if it has none running. */
function advance(pluginId: string, line: PluginPreviewLine): void {
  if (line.running) return
  const next = line.waiting.shift()
  if (!next) {
    if (line.pending.size === 0 && previewLines.get(pluginId) === line) previewLines.delete(pluginId)
    return
  }
  line.running = true
  // `runPreview` never rejects, so the line never stalls on a failure.
  void runPreview(pluginId, next.sourceId, next.options).then((preview) => {
    line.running = false
    line.pending.delete(next.key)
    next.answer(preview)
    advance(pluginId, line)
  })
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
    line = { running: false, waiting: [], pending: new Map() }
    previewLines.set(pluginId, line)
  }
  const held = line

  // The same question already waiting or being answered: share that answer.
  // It costs the plugin nothing more, so it is not counted against the asker.
  const key = JSON.stringify([sourceId, options.filters, options.limit])
  const shared = held.pending.get(key)
  if (shared) return shared

  const allowed = previewRateLimit.consume(`${userId}:${pluginId}`)
  if (!allowed.ok) return Promise.resolve({ status: 'busy', retryAfterMs: allowed.retryAfterMs })

  // A user waits in one place. Their newer question is the one they want
  // (the editor only ever needs the latest filter value), so it takes the
  // place of their older one, which is answered "busy".
  const mine = held.waiting.findIndex((entry) => entry.userId === userId)
  if (mine !== -1) {
    const [replaced] = held.waiting.splice(mine, 1)
    held.pending.delete(replaced!.key)
    replaced!.answer({ status: 'busy', retryAfterMs: BUSY_RETRY_AFTER_MS })
  } else if (held.running && held.waiting.length >= MAX_WAITING_PREVIEWS) {
    // The line is full of other people's questions: come back shortly. The
    // worker never hears of this one.
    return Promise.resolve({ status: 'busy', retryAfterMs: BUSY_RETRY_AFTER_MS })
  }

  const preview = new Promise<PluginLoopPreview>((answer) => {
    held.waiting.push({ key, userId, sourceId, options, answer })
  })
  held.pending.set(key, preview)
  advance(pluginId, held)
  return preview
}
