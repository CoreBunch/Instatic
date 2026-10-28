/**
 * Hook + types backing <ConfirmDeleteProvider/>.
 *
 * Lives in a non-component module because Fast Refresh requires component
 * files to export only components. Same split-file layout as
 * `frameworkChangeConfirmHook.ts`.
 */

import { createContext, use } from 'react'

export interface ConfirmDeleteRequest {
  /** Short title shown in the dialog header. e.g. "Delete header layer?" */
  title: string
  /** Optional secondary line — e.g. "This will remove all of its children." */
  description?: string
  /** Confirm button label — defaults to "Delete". */
  confirmLabel?: string
  /**
   * Force this request through the dialog even when the user's
   * `confirmBeforeDelete` preference is off. Use for destructive actions with
   * higher document-level blast radius, such as deleting a page.
   */
  alwaysConfirm?: boolean
  /** Action to execute on confirm or, when confirmation is skipped, immediately. */
  commit: () => void
  /**
   * `danger` (the default) styles the dialog and its confirm button as
   * destructive. `primary` is for consequential but non-destructive acts
   * (merging a branch into main, updating a branch from main).
   */
  tone?: 'danger' | 'primary'
}

export interface PendingConfirmState {
  request: ConfirmDeleteRequest
}

export interface ConfirmDeleteContextValue {
  /**
   * Request a confirmation. When the `confirmBeforeDelete` preference is on,
   * or the request sets `alwaysConfirm`, the dialog appears and `commit` runs
   * only after the user clicks Delete. Otherwise `commit` runs synchronously.
   */
  confirmDelete: (request: ConfirmDeleteRequest) => void
}

export const ConfirmDeleteContext = createContext<ConfirmDeleteContextValue | null>(null)

/**
 * Access the editor's central confirm-delete dispatch.
 *
 * When no `<ConfirmDeleteProvider/>` is mounted (e.g. unit-test renders that
 * mount a single panel in isolation), the hook falls back to executing
 * `commit()` immediately — the same behaviour as having the
 * `confirmBeforeDelete` preference turned off. This keeps consumers usable
 * outside the production provider tree without making every test fixture
 * wrap them.
 */
export function useConfirmDelete(): ConfirmDeleteContextValue['confirmDelete'] {
  const ctx = use(ConfirmDeleteContext)
  return ctx?.confirmDelete ?? ((request) => request.commit())
}


/**
 * Confirm a consequential, non-destructive action. Unlike `useConfirmDelete`
 * it never honours the `confirmBeforeDelete` preference: that preference is
 * about deletes, and a merge or an update should always ask.
 */
export function useConfirmAction(): (request: Omit<ConfirmDeleteRequest, 'alwaysConfirm'>) => void {
  const confirmDelete = useConfirmDelete()
  return (request) => confirmDelete({ tone: 'primary', ...request, alwaysConfirm: true })
}
