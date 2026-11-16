import { apiRequest, ApiError, isAbortError } from '@core/http'
import { UpdateDetailsSchema, UpdateStatusSchema, UPDATE_CACHE_MS, type UpdateDetails, type UpdateStatus } from '@core/updates'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'

interface UpdatesState {
  status: UpdateStatus | null
  details: UpdateDetails | null
  busy: boolean
  error: string | null
}

export const EMPTY_UPDATES: UpdatesState = { status: null, details: null, busy: false, error: null }

export function createUpdatesStore() {
  let state = EMPTY_UPDATES
  const listeners = new Set<() => void>()
  let pending: Promise<void> | null = null
  let controller: AbortController | null = null
  let expiryTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let active = false

  function publish(next: UpdatesState) {
    state = next
    for (const listener of listeners) listener()
  }

  function scheduleExpiry() {
    if (expiryTimer !== null) clearTimeout(expiryTimer)
    const checkedAt = state.status?.checkedAt
    if (checkedAt == null || state.status?.stale) return
    expiryTimer = setTimeout(() => {
      publish({ ...state,
        status: state.status ? { ...state.status, stale: true } : null,
        details: state.details ? { ...state.details, stale: true } : null,
      })
    }, Math.max(0, checkedAt + UPDATE_CACHE_MS - Date.now()))
  }

  async function load(details = false, refresh = false): Promise<void> {
    if (!active) return
    if (pending) {
      await pending
      if (details && !state.details) return load(details, refresh)
      return
    }
    if (!refresh && (details ? state.details !== null : state.status !== null)) return
    const requestGeneration = generation
    controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
    publish({ ...state, busy: true, error: null })
    pending = (async () => {
      try {
        let result: UpdateStatus
        let loadedDetails: UpdateDetails | null = null
        if (details) {
          loadedDetails = await apiRequest(refresh ? '/admin/api/cms/updates/check' : '/admin/api/cms/updates/details', {
            method: refresh ? 'POST' : 'GET', schema: UpdateDetailsSchema, signal,
          })
          result = loadedDetails
        } else {
          result = await apiRequest('/admin/api/cms/updates', { schema: UpdateStatusSchema, signal })
        }
        if (requestGeneration !== generation) return
        publish({ status: result, details: loadedDetails, busy: false, error: null })
        scheduleExpiry()
        if (refresh && result.error) pushToast({ kind: 'error', title: 'Update check failed', body: result.error })
      } catch (err) {
        if (requestGeneration !== generation || isAbortError(err) && controller?.signal.aborted) return
        const message = getErrorMessage(err, 'Unable to load Instatic release status')
        const denied = err instanceof ApiError && (err.status === 401 || err.status === 403)
        publish({ ...state, status: denied ? null : state.status, details: denied ? null : state.details, busy: false, error: message })
        if (refresh) pushToast({ kind: 'error', title: 'Update check failed', body: message })
      } finally {
        if (requestGeneration === generation) pending = null
      }
    })()
    return pending
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    start() { active = true; void load() },
    stop() {
      active = false
      generation++
      controller?.abort()
      pending = null
      if (expiryTimer !== null) clearTimeout(expiryTimer)
      publish(EMPTY_UPDATES)
    },
    loadDetails: () => load(true),
    refresh: () => load(true, true),
  }
}

export type UpdatesStore = ReturnType<typeof createUpdatesStore>
