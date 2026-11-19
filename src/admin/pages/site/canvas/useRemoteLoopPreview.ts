/**
 * Sample items for a loop whose source lives in a plugin.
 *
 * The plugin's `preview()` runs in its sandbox on the server, so every
 * preview is a request. One canvas shows the same loop in several breakpoint
 * frames, and several people may have the page open, so requests are shared:
 * every loop with the same source, filters and limit reads one cached answer,
 * a filter that is still being typed waits a moment before it asks, and an
 * answer is reused for a short while. The cache lives in this tab only.
 */
import { use, useEffect, useEffectEvent, useState } from 'react'
import type { LoopItem } from '@core/loops'
import { previewCmsLoopSource } from '@core/persistence/cmsLoopSources'
import { getErrorMessage } from '@core/utils/errorMessage'
import { CanvasPreviewReadinessContext } from './CanvasPreviewReadiness'

export type RemoteLoopPreview =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; items: LoopItem[] }
  | { status: 'failed'; error: string }

type Settled = Extract<RemoteLoopPreview, { status: 'ready' | 'failed' }>

interface CacheEntry {
  request: Promise<Settled>
  settled: Settled | null
  at: number
}

/** How long an answer is reused before the plugin is asked again. */
const PREVIEW_TTL_MS = 30_000
/** How long a changing filter must rest before the plugin is asked. */
const PREVIEW_DEBOUNCE_MS = 300
const MAX_CACHED_PREVIEWS = 50

const cache = new Map<string, CacheEntry>()
const IDLE: RemoteLoopPreview = { status: 'idle' }
const LOADING: RemoteLoopPreview = { status: 'loading' }

function freshEntry(key: string): CacheEntry | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.at > PREVIEW_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return entry
}

function requestPreview(
  key: string,
  sourceId: string,
  filters: Record<string, unknown>,
  limit: number,
): CacheEntry {
  const existing = freshEntry(key)
  if (existing) return existing
  const entry: CacheEntry = {
    at: Date.now(),
    settled: null,
    request: previewCmsLoopSource({ sourceId, filters, limit }).then(
      (items): Settled => ({ status: 'ready', items }),
      (err): Settled => ({
        status: 'failed',
        error: getErrorMessage(err, 'The plugin could not be reached.'),
      }),
    ),
  }
  void entry.request.then((settled) => {
    entry.settled = settled
  })
  if (cache.size >= MAX_CACHED_PREVIEWS) cache.clear()
  cache.set(key, entry)
  return entry
}

/** Forget every cached preview. Called when the set of plugin sources changes. */
export function clearRemoteLoopPreviews(): void {
  cache.clear()
}

/**
 * `sourceId` is null for a loop that is not on a plugin source; the hook then
 * stays idle and asks nothing.
 */
export function useRemoteLoopPreview(
  sourceId: string | null,
  filters: Record<string, unknown>,
  limit: number,
): RemoteLoopPreview {
  const previewReadiness = use(CanvasPreviewReadinessContext)
  const key = sourceId === null ? null : JSON.stringify([sourceId, filters, limit])
  const [answer, setAnswer] = useState<{ key: string; settled: Settled } | null>(null)
  // `key` is the serialized form of the three arguments, so the effect below
  // depends on it alone and reads the values it stands for through here.
  const requestCurrent = useEffectEvent((requestKey: string, requestSourceId: string) =>
    requestPreview(requestKey, requestSourceId, filters, limit),
  )

  useEffect(() => {
    if (key === null || sourceId === null) return
    let cancelled = false
    const deliver = (entry: CacheEntry) => {
      const delivered = entry.request.then((settled) => {
        if (!cancelled) setAnswer({ key, settled })
      })
      previewReadiness?.track(delivered)
    }
    const cached = freshEntry(key)
    if (cached) {
      deliver(cached)
      return () => {
        cancelled = true
      }
    }
    const timer = setTimeout(() => {
      deliver(requestCurrent(key, sourceId))
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [key, sourceId, previewReadiness])

  if (key === null) return IDLE
  if (answer?.key === key) return answer.settled
  return freshEntry(key)?.settled ?? LOADING
}
