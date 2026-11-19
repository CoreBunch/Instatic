/**
 * Sample items for a loop whose source lives in a plugin: the hook over
 * `remoteLoopPreviews.ts`, which holds the shared answers and their upkeep.
 */
import { use, useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import { CanvasPreviewReadinessContext } from './CanvasPreviewReadiness'
import {
  holdRemoteLoopPreview,
  remoteLoopPreviewKey,
  remoteLoopPreviewSnapshot,
  subscribeRemoteLoopPreviews,
  type RemoteLoopPreview,
} from './remoteLoopPreviews'

const IDLE = { status: 'idle' } as const

/**
 * `sourceId` is null for a loop that is not on a plugin source; the hook then
 * stays idle and asks nothing.
 */
export function useRemoteLoopPreview(
  sourceId: string | null,
  filters: Record<string, unknown>,
  limit: number,
): RemoteLoopPreview | typeof IDLE {
  const previewReadiness = use(CanvasPreviewReadinessContext)
  const key = sourceId === null ? null : remoteLoopPreviewKey({ sourceId, filters, limit })
  // The value this returns is the store's own state object for the key: a new
  // object whenever the answer changes, the same one otherwise.
  const preview = useSyncExternalStore(subscribeRemoteLoopPreviews, () =>
    key === null ? IDLE : remoteLoopPreviewSnapshot(key),
  )
  // `key` is the serialized form of the three arguments, so the effect below
  // depends on it alone and reads the values it stands for through here.
  const hold = useEffectEvent((heldSourceId: string) =>
    holdRemoteLoopPreview({ sourceId: heldSourceId, filters, limit }),
  )

  useEffect(() => {
    if (key === null || sourceId === null) return
    const held = hold(sourceId)
    previewReadiness?.track(held.firstAnswer)
    return held.release
  }, [key, sourceId, previewReadiness])

  return preview
}
