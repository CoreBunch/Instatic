/**
 * Sample items for loops whose source lives in a plugin: the store.
 *
 * The plugin's `preview()` runs in its sandbox on the server, so every
 * preview is a request, and the answer is sample data that does not go
 * stale. The store therefore asks as little as it can:
 *
 *   - one request per source, filters and limit for the life of the editor.
 *     Every loop with the same three shares the answer, and it is kept after
 *     the loops are gone. Nothing is refreshed on a timer: an editor left
 *     alone makes no preview requests;
 *   - a new question waits `PREVIEW_DEBOUNCE_MS` before it is sent, and one
 *     that nobody shows any more by then (a filter value typed over) is never
 *     sent. A request overtaken while in flight is cancelled;
 *   - an answer belongs to the revision of the source it was asked under (a
 *     revision is one load of the plugin). `syncRemoteLoopPreviews` asks again
 *     for answers whose source has a newer revision, and nothing else does
 *     except the author (`retryRemoteLoopPreview`);
 *   - a "busy" answer (the plugin's previews are queued, or this user asked
 *     too often) is waited out for as long as the server says, and is never
 *     reported as the plugin failing;
 *   - a real failure is retried `PREVIEW_MAX_RETRIES` times at growing
 *     intervals and then left for the author to retry;
 *   - an answer that was good stays on screen while it is asked for again,
 *     and stays if asking again fails.
 *
 * Everything here is kept in this tab only. State changes replace the
 * entry's `state` object, so `useSyncExternalStore` readers see each change
 * and nothing is read from the clock during a render.
 */
import { LOOP_PREVIEW_BUSY_CODE, loopSourceRegistry, type LoopItem } from '@core/loops'
import { ApiError, isAbortError } from '@core/http'
import { previewCmsLoopSource } from '@core/persistence/cmsLoopSources'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestLoopSourcesRefresh } from './loopSourceEvents'

export type RemoteLoopPreview =
  | { status: 'loading' }
  | { status: 'ready'; items: LoopItem[] }
  /** The server is holding previews back; the store is waiting to ask again. */
  | { status: 'busy' }
  /** `final` once the store has stopped retrying by itself. */
  | { status: 'failed'; error: string; final: boolean }

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
  /** The pending debounce or retry. */
  timer: ReturnType<typeof setTimeout> | null
  /** The request in flight, so it can be cancelled. */
  inFlight: AbortController | null
  /** Whether the question was ever sent. */
  asked: boolean
  /** The source's revision when the question was last sent; null before that. */
  revision: string | null
  /** Settles when the entry first has an answer. */
  firstAnswer: Promise<void>
  resolveFirstAnswer: () => void
}

/** How long a new question waits, in case it is still being typed. */
export const PREVIEW_DEBOUNCE_MS = 600
/** How often a failed preview is asked for again before the author must. */
export const PREVIEW_MAX_RETRIES = 3
/** First wait after a failure; doubles with each further one. */
export const PREVIEW_RETRY_MS = 2_000
/** How long to wait on a busy answer that names no time. */
const PREVIEW_BUSY_RETRY_MS = 2_000
/** The longest a busy answer is waited out before asking again. */
const PREVIEW_BUSY_RETRY_MAX_MS = 60_000
const MAX_KEPT_ANSWERS = 200

const LOADING: RemoteLoopPreview = { status: 'loading' }
const BUSY: RemoteLoopPreview = { status: 'busy' }
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

function stop(entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = null
  entry.inFlight?.abort()
  entry.inFlight = null
}

function setState(entry: Entry, state: RemoteLoopPreview): void {
  if (entry.state === state) return
  entry.state = state
  emit()
}

function later(key: string, entry: Entry, delayMs: number): void {
  entry.timer = setTimeout(() => {
    entry.timer = null
    // Nobody shows it any more: the next loop that does will ask.
    if (entry.holders > 0) load(key, entry)
    else if (entry.state.status !== 'ready') entries.delete(key)
  }, delayMs)
}

/** The revision of a source the editor lists as a plugin's; null when it lists none. */
function listedRevision(sourceId: string): string | null {
  const source = loopSourceRegistry.get(sourceId)
  return source?.kind === 'remote' ? source.revision : null
}

function load(key: string, entry: Entry): void {
  stop(entry)
  const controller = new AbortController()
  entry.inFlight = controller
  entry.asked = true
  entry.revision = listedRevision(entry.request.sourceId)
  const hadItems = entry.state.status === 'ready'
  previewCmsLoopSource(entry.request, controller.signal).then(
    (items) => {
      if (entry.inFlight !== controller) return
      entry.inFlight = null
      entry.failures = 0
      setState(entry, { status: 'ready', items })
      entry.resolveFirstAnswer()
    },
    (err: unknown) => {
      if (entry.inFlight !== controller || isAbortError(err)) return
      entry.inFlight = null
      entry.resolveFirstAnswer()

      if (err instanceof ApiError && err.status === 429 && err.code === LOOP_PREVIEW_BUSY_CODE) {
        // Not the plugin's fault and not counted as a failure.
        if (!hadItems) setState(entry, BUSY)
        later(key, entry, Math.min(err.retryAfterMs ?? PREVIEW_BUSY_RETRY_MS, PREVIEW_BUSY_RETRY_MAX_MS))
        return
      }

      entry.failures += 1
      const final = entry.failures > PREVIEW_MAX_RETRIES
      if (!final) later(key, entry, PREVIEW_RETRY_MS * 2 ** (entry.failures - 1))
      // A loop that has items keeps them: a failed refresh is not a reason to
      // empty it.
      if (!hadItems) {
        setState(entry, {
          status: 'failed',
          error: getErrorMessage(err, 'The plugin could not be reached.'),
          final,
        })
      }
      // The server says nobody provides this source, yet the editor still
      // lists it: the editor's list is out of date. (Once the list has caught
      // up the source is no longer listed, and this stops.)
      const listed = listedRevision(entry.request.sourceId) !== null
      if (listed && err instanceof ApiError && err.status === 404) {
        requestLoopSourcesRefresh()
      }
    },
  )
}

function dropUnheldAnswers(): void {
  if (entries.size <= MAX_KEPT_ANSWERS) return
  for (const [key, entry] of entries) {
    if (entry.holders === 0) {
      stop(entry)
      entries.delete(key)
    }
    if (entries.size <= MAX_KEPT_ANSWERS / 2) return
  }
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
      inFlight: null,
      asked: false,
      revision: null,
      firstAnswer,
      resolveFirstAnswer,
    }
    entries.set(key, entry)
    dropUnheldAnswers()
  }
  entry.holders += 1
  // A question nobody has asked yet. One that was asked keeps its course:
  // another loop showing it neither sends it again nor restarts the retries
  // of a preview that has finally failed.
  if (!entry.asked && !entry.timer) later(key, entry, PREVIEW_DEBOUNCE_MS)
  const held = entry
  let released = false
  return {
    firstAnswer: held.firstAnswer,
    release() {
      if (released) return
      released = true
      held.holders -= 1
      if (held.holders > 0 || held.state.status === 'ready') return
      // Nobody is waiting for this any more (a filter value typed over): do
      // not send it, and cancel it if it is already on its way.
      stop(held)
      held.resolveFirstAnswer()
      // Only this entry: the key may by now belong to a newer one.
      if (entries.get(key) === held) entries.delete(key)
    },
  }
}

/**
 * Bring the answers in line with the list of plugin sources the registry
 * now holds. Called after every fetch of that list. An answer asked under an
 * older revision of its source (the plugin was upgraded or restarted since)
 * is asked for again if a loop shows it, and forgotten otherwise. An answer
 * whose source is no longer listed is left alone: its loops are about to let
 * go of it, and it is forgotten once they have. Answers under the current
 * revision are untouched, so the same list coming back asks nothing.
 */
export function syncRemoteLoopPreviews(): void {
  for (const [key, entry] of entries) {
    const revision = listedRevision(entry.request.sourceId)
    if (!entry.asked || entry.revision === revision) continue
    if (revision !== null && entry.holders > 0) {
      entry.failures = 0
      load(key, entry)
    } else if (entry.holders === 0) {
      stop(entry)
      entries.delete(key)
    } else {
      stop(entry)
    }
  }
}

/** Ask again for one preview now: the author's "Try again". */
export function retryRemoteLoopPreview(request: RemoteLoopPreviewRequest): void {
  const key = remoteLoopPreviewKey(request)
  const entry = entries.get(key)
  if (!entry) return
  entry.failures = 0
  setState(entry, LOADING)
  load(key, entry)
}

/** Drop everything, timers and requests included. For tests. */
export function resetRemoteLoopPreviews(): void {
  for (const entry of entries.values()) stop(entry)
  entries.clear()
}
