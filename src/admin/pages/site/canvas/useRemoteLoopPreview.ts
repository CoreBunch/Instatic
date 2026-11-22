/**
 * Sample items for a loop whose source lives in a plugin: the hook over
 * `remoteLoopPreviews.ts`, which holds the shared answers.
 */
import { use, useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react'
import type { LoopItem } from '@core/loops'
import { CanvasPreviewReadinessContext } from './CanvasPreviewReadiness'
import {
  holdRemoteLoopPreview,
  remoteLoopPreviewKey,
  remoteLoopPreviewSnapshot,
  subscribeRemoteLoopPreviews,
  type RemoteLoopPreview,
} from './remoteLoopPreviews'

const IDLE = { status: 'idle' } as const
const NO_ITEMS: LoopItem[] = []

export interface RemoteLoopPreviewView {
  /** Where the answer to the loop's current source, filters and limit stands. */
  preview: RemoteLoopPreview | typeof IDLE
  /**
   * What the loop draws: the current answer's items, or, while a changed
   * filter's answer is on its way (or did not come), the last items this
   * loop had from the same source. Empty until there has been an answer.
   */
  items: LoopItem[]
}

/**
 * `sourceId` is null for a loop that is not on a plugin source; the hook then
 * stays idle and asks nothing.
 */
export function useRemoteLoopPreview(
  sourceId: string | null,
  filters: Record<string, unknown>,
  limit: number,
): RemoteLoopPreviewView {
  const previewReadiness = use(CanvasPreviewReadinessContext)
  const key = sourceId === null ? null : remoteLoopPreviewKey({ sourceId, filters, limit })
  // The value this returns is the store's own state object for the key: a new
  // object whenever the answer changes, the same one otherwise.
  const preview = useSyncExternalStore(subscribeRemoteLoopPreviews, () =>
    key === null ? IDLE : remoteLoopPreviewSnapshot(key),
  )

  // The last good answer this loop had, and the source it came from. Updated
  // while rendering, the way React asks derived state to be kept.
  const [last, setLast] = useState<{ sourceId: string; items: LoopItem[] } | null>(null)
  if (sourceId !== null && preview.status === 'ready' && last?.items !== preview.items) {
    setLast({ sourceId, items: preview.items })
  }

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

  if (preview.status === 'ready') return { preview, items: preview.items }
  const kept = sourceId !== null && last?.sourceId === sourceId ? last.items : NO_ITEMS
  return { preview, items: kept }
}
