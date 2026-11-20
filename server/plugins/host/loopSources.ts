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
 *     waits in a line of at most `MAX_WAITING_PREVIEWS`, of which one user
 *     may hold `MAX_WAITING_PER_USER`; past either the asker is told the
 *     plugin is busy and the worker never hears of it;
 *   - each user may start only so many previews per plugin per minute. A
 *     question turned away as busy is not counted;
 *   - a waiting preview is dropped if its plugin is no longer loaded when its
 *     turn comes, so a preview never starts a worker for a plugin that was
 *     disabled, removed or parked meanwhile.
 *
 * What this guarantees: previews that answer cannot pile up in the worker
 * until the host's reply deadline runs out. A full line is thirteen previews
 * of at most a second each, so the last one waits about thirteen seconds,
 * well inside the thirty the host allows a worker call. What it does not do:
 * make a slow `preview()` cheap. Previews are meant to return sample data
 * instantly; one that takes a second lets a single asker keep the plugin's
 * worker busy for as long as they keep asking, which slows the plugin's
 * routes and everyone else's previews (nothing crashes or hangs). And a
 * `preview()` that never returns is the plugin's own code hanging, treated
 * like any call into that plugin
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
    for (const { sourceId, pluginId, revision } of entry.loopSources) {
      const source = loopSourceRegistry.get(sourceId)
      if (!source) continue
      sources.push({
        id: source.id,
        label: source.label,
        ...(source.description !== undefined ? { description: source.description } : {}),
        filterSchema: source.filterSchema,
        orderByOptions: source.orderByOptions,
        fields: source.fields,
        ...(source.defaultDirection ? { defaultDirection: source.defaultDirection } : {}),
        ...(source.requestDependent ? { requestDependent: true } : {}),
        ...(source.perVisitor ? { perVisitor: true } : {}),
        provider: { pluginId, pluginName: entry.manifest.name },
        revision,
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
 * Sized for a page of twelve loops on one plugin's sources (twelve questions
 * per load of the editor, the most one canvas preview shows of any list)
 * reloaded several times in a minute, with room for filter edits. Honest use
 * stays far below it; it exists to stop a script.
 */
const previewRateLimit = new RateLimiter({ limit: 120, windowMs: 60_000 })

/**
 * Previews that may wait behind the one a plugin's worker is running: enough
 * for every loop of a twelve-loop page to be asked about at once.
 */
const MAX_WAITING_PREVIEWS = 12

/**
 * How many of those places one user may hold: one short of the line, so a
 * twelve-loop page still fits (one running, eleven waiting). The twelfth
 * place is someone else's to take, but it is one place behind eleven: with a
 * slow `preview()` a user who keeps asking still gets nearly all of the
 * worker's time. The line bounds the wait; it does not share the worker out.
 */
const MAX_WAITING_PER_USER = 11

/** What a refused asker is told to wait: a few places in the line clear in about this long. */
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

  // A full line, or this user's share of it: come back shortly. The worker
  // never hears of this one, and it is not counted against the asker.
  const waitingForUser = held.waiting.filter((entry) => entry.userId === userId).length
  if (
    held.running &&
    (held.waiting.length >= MAX_WAITING_PREVIEWS || waitingForUser >= MAX_WAITING_PER_USER)
  ) {
    return Promise.resolve({ status: 'busy', retryAfterMs: BUSY_RETRY_AFTER_MS })
  }

  const allowed = previewRateLimit.consume(`${userId}:${pluginId}`)
  if (!allowed.ok) return Promise.resolve({ status: 'busy', retryAfterMs: allowed.retryAfterMs })

  const preview = new Promise<PluginLoopPreview>((answer) => {
    held.waiting.push({ key, userId, sourceId, options, answer })
  })
  held.pending.set(key, preview)
  advance(pluginId, held)
  return preview
}
