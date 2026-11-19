/**
 * Site notices in the editor.
 *
 * The site socket carries a few facts that are not document content but that
 * every open editor must hear of (`FRAME_NOTICE` in `@core/collab`). The
 * collab provider hands each one here; whoever keeps the matching state
 * subscribes and fetches the new state over HTTP.
 */
import type { SiteNotice } from '@core/collab'

const listeners = new Map<SiteNotice, Set<() => void>>()

export function subscribeSiteNotice(notice: SiteNotice, listener: () => void): () => void {
  let set = listeners.get(notice)
  if (!set) {
    set = new Set()
    listeners.set(notice, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

export function emitSiteNotice(notice: SiteNotice): void {
  for (const listener of listeners.get(notice) ?? []) listener()
}
