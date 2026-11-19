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
 * plugin's real work. Three things keep an editor from crowding that work
 * out: a preview may run for one second (`LOOP_PREVIEW_TIMEOUT_MS`),
 * identical previews in flight share one run, and each user may start only
 * so many per source per minute. An overrun is an error answer; it is not a
 * worker fault and never counts toward the plugin's crash budget.
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

/** How long a burst of registrations is gathered into one notification. */
const CHANGE_DEBOUNCE_MS = 200

/**
 * Call `listener` after the set of registered loop sources changed. A plugin
 * registers its sources one by one on activation, and an upgrade unregisters
 * and registers them again, so changes close together are reported once.
 * Covers every way the set moves: enable, disable, upgrade, uninstall, and a
 * worker that crashed or came back.
 */
export function onPluginLoopSourcesChanged(listener: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const unsubscribe = loopSourceRegistry.subscribe(() => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      listener()
    }, CHANGE_DEBOUNCE_MS)
  })
  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
  }
}

export type PluginLoopPreview =
  | { status: 'ok'; items: LoopItem[] }
  | { status: 'unknown-source' }
  | { status: 'rate-limited'; retryAfterMs: number }
  | { status: 'failed'; error: string }

/**
 * The editor caches a preview for 30 seconds and asks again only when a
 * filter changes, so thirty a minute is far above honest use.
 */
const previewRateLimit = new RateLimiter({ limit: 30, windowMs: 60_000 })

/** How deep a field value may nest. A list of objects of lists is depth 3. */
const MAX_FIELD_DEPTH = 6

const inFlight = new Map<string, Promise<PluginLoopPreview>>()

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
export async function previewPluginLoopSource(
  userId: string,
  sourceId: string,
  options: { filters: Record<string, unknown>; limit: number },
): Promise<PluginLoopPreview> {
  const pluginId = owningPluginId(sourceId)
  if (!pluginId) return { status: 'unknown-source' }

  // The same question already being answered: wait for that answer. It costs
  // the plugin nothing more, so it is not counted against the asker.
  const key = JSON.stringify([sourceId, options.filters, options.limit])
  const running = inFlight.get(key)
  if (running) return running

  const allowed = previewRateLimit.consume(`${userId}:${sourceId}`)
  if (!allowed.ok) return { status: 'rate-limited', retryAfterMs: allowed.retryAfterMs }

  const run = runPreview(pluginId, sourceId, options).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, run)
  return run
}
