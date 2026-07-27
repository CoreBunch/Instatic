/**
 * usePageAccessDialog — state + commit wiring for the per-page access dialog
 * (Phase 3 — D14).
 *
 * Co-located with {@link PageAccessDialog} so the dialog owns its own open /
 * cancel / save lifecycle. The Site Explorer panel calls `open(page)` from the
 * page context menu and renders `{target && <PageAccessDialog .../>}`. Keeps
 * the dialog-management state out of the explorer shell, which owns enough
 * unrelated dialog wirings already.
 */
import { useState } from 'react'
import type { Page, PageAccess } from '@core/page-tree'
import type { PageAccessPayload } from './PageAccessDialog'

export interface PageAccessDialogState {
  /** The page currently being edited, or `null` when the dialog is closed. */
  target: Page | null
  /** Open the dialog for a page (called from the context menu). */
  open: (page: Page) => void
  /** Close without saving. */
  cancel: () => void
  /** Commit the resolved access level via the store action and close. */
  save: (payload: PageAccessPayload) => void
}

/**
 * @param setPageAccess The `setPageAccess` store action (writes the page's
 *                      `access` field — public clears it, groups persists it).
 */
export function usePageAccessDialog(
  setPageAccess: (pageId: string, access: PageAccess) => void,
): PageAccessDialogState {
  const [target, setTarget] = useState<Page | null>(null)

  return {
    target,
    open: (page) => setTarget(page),
    cancel: () => setTarget(null),
    save: (payload) => {
      if (!target) return
      setPageAccess(target.id, payload.access)
      setTarget(null)
    },
  }
}
