/**
 * Hook + types backing <ConfirmDeleteProvider/>.
 *
 * Lives in a non-component module because Fast Refresh requires component
 * files to export only components. Same split-file layout as
 * `frameworkChangeConfirmHook.ts`.
 */

import { createContext, use, type ReactNode } from 'react'

export interface ConfirmDeleteRequest {
  /** Short title shown in the dialog header. e.g. "Delete header layer?" */
  title: string
  /** Optional secondary line — e.g. "This will remove all of its children." */
  description?: string
  /** Confirm button label — defaults to "Delete". */
  confirmLabel?: string
  /**
   * Extra content below the description — a caller-owned detail the generic
   * dialog knows nothing about. Media passes the list of things that still
   * depend on the files being deleted; most callers pass nothing.
   */
  details?: ReactNode
  /**
   * Force this request through the dialog even when the user's
   * `confirmBeforeDelete` preference is off. Use for destructive actions with
   * higher document-level blast radius, such as deleting a page.
   */
  alwaysConfirm?: boolean
  /** Action to execute on confirm or, when confirmation is skipped, immediately. */
  commit: () => void
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
