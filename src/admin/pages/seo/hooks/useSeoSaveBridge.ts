/**
 * useSeoSaveBridge — connects whichever SEO editor is active (target editor,
 * site defaults, robots, sitemap) to the workspace toolbar's save/publish
 * controls, mirroring how the Site and Content workspaces drive their
 * toolbar PublishActionGroup.
 *
 * Split deliberately in two channels:
 *   - `status` is serializable view state (dirty/save-state/capabilities),
 *     reported through React state so the toolbar re-renders with it.
 *   - the save/publish handlers flow through a ref private to this hook —
 *     they change identity every editor render, and the toolbar only needs
 *     the latest at click time, not a re-render per keystroke. `save` /
 *     `publish` are stable closures over that ref.
 *
 * Editors call `useSeoSaveSurface` once; it reports on change and withdraws
 * the surface on unmount, so tab/target switches hand the toolbar over
 * cleanly.
 */
import { useEffect, useRef, useState } from 'react'
import type { SeoSaveState } from './useSeoDraft'

export interface SeoSaveStatus {
  dirty: boolean
  state: SeoSaveState
  /** False when the user lacks `seo.manage` — save is disabled with reason. */
  canSave: boolean
  /** False when the user lacks the publish capability for this scope. */
  canPublish: boolean
  /** 'row' = incremental post publish; 'site' = step-up gated full publish. */
  publishScope: 'row' | 'site'
  /** Public URL the active surface affects, for the "Open live" menu item. */
  liveUrl: string | null
}

export interface SeoSaveActions {
  save: () => void
  publish: () => void
}

export interface SeoSaveBridge {
  status: SeoSaveStatus | null
  reportStatus: (status: SeoSaveStatus | null) => void
  /** Latest-handler registration — called by the active editor each render. */
  setActions: (actions: SeoSaveActions | null) => void
  /** Invoke the active editor's handlers (no-ops with no surface). */
  save: () => void
  publish: () => void
}

export function useSeoSaveBridge(): SeoSaveBridge {
  const [status, setStatus] = useState<SeoSaveStatus | null>(null)
  const actionsRef = useRef<SeoSaveActions | null>(null)
  // Stable closures over the private ref — one identity for the bridge's
  // whole lifetime, so registering them in effects costs nothing.
  const [stable] = useState(() => ({
    setActions: (actions: SeoSaveActions | null) => {
      actionsRef.current = actions
    },
    save: () => actionsRef.current?.save(),
    publish: () => actionsRef.current?.publish(),
  }))
  return { status, reportStatus: setStatus, ...stable }
}

/** Register the calling editor as the toolbar's active save surface. */
export function useSeoSaveSurface(
  bridge: SeoSaveBridge,
  status: SeoSaveStatus,
  actions: SeoSaveActions,
): void {
  const { reportStatus, setActions } = bridge
  const { dirty, state, canSave, canPublish, publishScope, liveUrl } = status

  // Latest-closure pattern: re-registered every render so the toolbar always
  // invokes handlers that see the current draft.
  useEffect(() => {
    setActions(actions)
  })

  useEffect(() => {
    reportStatus({ dirty, state, canSave, canPublish, publishScope, liveUrl })
  }, [reportStatus, dirty, state, canSave, canPublish, publishScope, liveUrl])

  useEffect(
    () => () => {
      reportStatus(null)
      setActions(null)
    },
    [reportStatus, setActions],
  )
}
