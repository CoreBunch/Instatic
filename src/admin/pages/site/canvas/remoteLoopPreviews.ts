/**
 * Sample items for loops whose source lives in a plugin: the store.
 *
 * The plugin's `preview()` runs in its sandbox on the server, so every
 * preview is a request. One canvas shows the same loop in several breakpoint
 * frames, so loops with the same source, filters and limit share one entry
 * here. An entry lives as long as a mounted loop holds it:
 *
 *   - a new entry waits a moment before it asks, so a filter that is still
 *     being typed does not ask once per keystroke;
 *   - a good answer is asked for again after `PREVIEW_TTL_MS`, a failed one
 *     sooner and then at growing intervals, for as long as the entry is held;
 *   - `refreshRemoteLoopPreviews()` asks again for every held entry at once
 *     (the plugin behind a source may have changed) and drops the rest.
 *
 * An answer being refreshed stays on screen until the new one arrives.
 * Everything here is kept in this tab only. State changes replace the
 * entry's `state` object, so `useSyncExternalStore` readers see each change
 * and nothing is read from the clock during a render.
 */
import { loopSourceRegistry, type LoopItem } from '@core/loops'
import { ApiError } from '@core/http'
import { previewCmsLoopSource } from '@core/persistence/cmsLoopSources'
import { getErrorMessage } from '@core/utils/errorMessage'

export type RemoteLoopPreview =
  | { status: 'loading' }
  | { status: 'ready'; items: LoopItem[] }
  | { status: 'failed'; error: string }

export interface RemoteLoopPreviewRequest {
  sourceId: string
  filters: Record<string, unknown>
  limit: number
}

interface Entry {
  request: RemoteLoopPreviewRequest
  state: RemoteLoopPreview
  holders: number
  failures: number
  /** The pending debounce, refresh or retry. */
  timer: ReturnType<typeof setTimeout> | null
  /** Bumped on every load, so an answer overtaken by a newer load is dropped. */
  generation: number
  /** Settles when the entry first has an answer. */
  firstAnswer: Promise<void>
  resolveFirstAnswer: () => void
}

/** How long a good answer is shown before the plugin is asked again. */
export const PREVIEW_TTL_MS = 30_000
/** How long a new question waits, in case it is still being typed. */
export const PREVIEW_DEBOUNCE_MS = 300
/** First wait after a failure; doubles up to `PREVIEW_RETRY_MAX_MS`. */
export const PREVIEW_RETRY_MS = 5_000
const PREVIEW_RETRY_MAX_MS = 60_000

/** Fired on `window` when a preview is refused because nobody provides the source. */
export const LOOP_SOURCES_STALE_EVENT = 'instatic:loop-sources-stale'

const LOADING: RemoteLoopPreview = { status: 'loading' }
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function remoteLoopPreviewKey(request: RemoteLoopPreviewRequest): string {
  return JSON.stringify([request.sourceId, request.filters, request.limit])
}

export function subscribeRemoteLoopPreviews(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The current answer for a key. The same object until that answer changes. */
export function remoteLoopPreviewSnapshot(key: string): RemoteLoopPreview {
  return entries.get(key)?.state ?? LOADING
}

function schedule(key: string, entry: Entry, delayMs: number): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    if (entry.holders > 0) load(key, entry)
    else entries.delete(key)
  }, delayMs)
}

function load(key: string, entry: Entry): void {
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  const generation = ++entry.generation
  previewCmsLoopSource(entry.request).then(
    (items) => {
      if (entry.generation !== generation) return
      entry.failures = 0
      entry.state = { status: 'ready', items }
      schedule(key, entry, PREVIEW_TTL_MS)
    },
    (err: unknown) => {
      if (entry.generation !== generation) return
      entry.failures += 1
      entry.state = {
        status: 'failed',
        error: getErrorMessage(err, 'The plugin could not be reached.'),
      }
      schedule(key, entry, Math.min(PREVIEW_RETRY_MS * 2 ** (entry.failures - 1), PREVIEW_RETRY_MAX_MS))
      // The server says nobody provides this source, yet the editor still
      // lists it: the editor's list is out of date. (Once the list has caught
      // up the source is no longer listed, and this stops.)
      const listed = loopSourceRegistry.get(entry.request.sourceId)?.kind === 'remote'
      if (listed && err instanceof ApiError && err.status === 404) {
        window.dispatchEvent(new Event(LOOP_SOURCES_STALE_EVENT))
      }
    },
  ).finally(() => {
    if (entry.generation !== generation) return
    entry.resolveFirstAnswer()
    emit()
  })
}

/**
 * Hold the preview for `request` while a loop shows it. Returns the release
 * function and a promise for the entry's first answer.
 */
export function holdRemoteLoopPreview(
  request: RemoteLoopPreviewRequest,
): { release: () => void; firstAnswer: Promise<void> } {
  const key = remoteLoopPreviewKey(request)
  let entry = entries.get(key)
  if (!entry) {
    let resolveFirstAnswer = () => {}
    const firstAnswer = new Promise<void>((resolve) => {
      resolveFirstAnswer = resolve
    })
    entry = {
      request,
      state: LOADING,
      holders: 0,
      failures: 0,
      timer: null,
      generation: 0,
      firstAnswer,
      resolveFirstAnswer,
    }
    entries.set(key, entry)
    schedule(key, entry, PREVIEW_DEBOUNCE_MS)
  }
  entry.holders += 1
  const held = entry
  let released = false
  return {
    firstAnswer: held.firstAnswer,
    release() {
      if (released) return
      released = true
      held.holders -= 1
      // Never asked and nobody waiting: the question was abandoned mid-typing.
      if (held.holders === 0 && held.generation === 0) {
        if (held.timer) clearTimeout(held.timer)
        held.resolveFirstAnswer()
        entries.delete(key)
      }
    },
  }
}

/**
 * Ask again for every preview a loop is showing, and forget the rest. Called
 * when the set of plugin sources changed: a source may have gone, come back,
 * or be a newer version under the same id.
 */
export function refreshRemoteLoopPreviews(): void {
  for (const [key, entry] of entries) {
    if (entry.holders > 0) {
      entry.failures = 0
      load(key, entry)
    } else {
      if (entry.timer) clearTimeout(entry.timer)
      entries.delete(key)
    }
  }
}

/** Drop everything, timers included. For tests. */
export function resetRemoteLoopPreviews(): void {
  for (const entry of entries.values()) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.generation += 1
  }
  entries.clear()
}
