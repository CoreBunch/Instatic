/**
 * ConfirmDeleteProvider — single-instance dialog host for destructive
 * editor actions (delete layer, delete page, etc.).
 *
 * Reads the `confirmBeforeDelete` editor preference. When enabled, or when a
 * request opts into `alwaysConfirm`, calling `confirmDelete(request)` mounts
 * <ConfirmDeleteDialog/> and runs `request.commit` only after the user
 * confirms. Otherwise `commit` runs synchronously — preserving the previous
 * one-key layer-delete flow for users who opt out of confirmations.
 *
 * One provider mounted at the editor root replaces N inline confirm states
 * across panels and the canvas.
 *
 * The hook + types + context object live next door in `confirmDeleteHook.ts`
 * so this file remains a pure component module (Fast Refresh requires
 * component files to export only components).
 */

import { useState, type ReactNode } from 'react'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import {
  ConfirmDeleteContext,
  type ConfirmDeleteContextValue,
  type ConfirmDeleteRequest,
  type PendingConfirmState,
} from './confirmDeleteHook'

export function ConfirmDeleteProvider({ children }: { children: ReactNode }) {
  const confirmBeforeDelete = useEditorPreference('confirmBeforeDelete')
  const [pending, setPending] = useState<PendingConfirmState | null>(null)

  const confirmDelete = (request: ConfirmDeleteRequest) => {
    if (!confirmBeforeDelete && !request.alwaysConfirm) {
      request.commit()
      return
    }
    setPending({ request })
  }

  const value: ConfirmDeleteContextValue = { confirmDelete }

  const handleCancel = () => {
    setPending(null)
  }

  const handleConfirm = () => {
    if (!pending) return
    pending.request.commit()
    setPending(null)
  }

  return (
    <ConfirmDeleteContext.Provider value={value}>
      {children}
      {pending && (
        <ConfirmDeleteDialog
          title={pending.request.title}
          description={pending.request.description}
          confirmLabel={pending.request.confirmLabel}
          tone={pending.request.tone}
          onCancel={handleCancel}
          onConfirm={handleConfirm}
        />
      )}
    </ConfirmDeleteContext.Provider>
  )
}
