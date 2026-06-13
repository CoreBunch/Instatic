/**
 * ConfirmDeleteDialog — generic two-button "are you sure?" prompt for
 * destructive actions in the editor.
 *
 * Driven by the `confirmBeforeDelete` editor preference plus per-request
 * `alwaysConfirm` overrides: callers don't render this directly — they call
 * `useConfirmDelete()`. See `ConfirmDeleteContext.tsx` for the wiring.
 *
 * Built on the shared `<Dialog>` primitive — the chrome (backdrop, header,
 * footer, focus + Esc handling, portal mount) lives there. This module
 * only owns the two-button confirmation contract.
 */

import { useEffect, useRef } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'

interface ConfirmDeleteDialogProps {
  /** Short, action-style title. e.g. "Delete layer?" */
  title: string
  /** Optional secondary line shown beneath the title. */
  description?: string
  /** Confirm button label — defaults to "Delete". */
  confirmLabel?: string
  /** Cancel button label — defaults to "Cancel". */
  cancelLabel?: string
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDeleteDialog({
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onCancel,
  onConfirm,
}: ConfirmDeleteDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Enter activates the focused (Confirm) button natively, but we add a
  // document-level handler too so callers don't lose Enter even when focus
  // moves to a different element inside the dialog body.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        onConfirm()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onConfirm])

  return (
    <Dialog
      open
      onClose={onCancel}
      tone="danger"
      title={title}
      size="sm"
      initialFocusRef={confirmRef}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant="destructive"
            size="sm"
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && <p>{description}</p>}
    </Dialog>
  )
}
