/**
 * LayoutNameDialog — the naming step for user-saved layouts.
 *
 * Serves both `layoutNameDialogRequest` modes from the ui slice:
 *   - `create`: "Save as layout" from the canvas / DOM-panel context menu —
 *     captures the node's subtree via `saveNodeAsLayout`.
 *   - `rename`: rename of an existing saved layout (reached from the module
 *     inserter's saved-layout context menu, which closes itself first — the
 *     inserter sits above the Dialog layer).
 *
 * Name validation errors (`SavedLayoutNameError`: empty / duplicate) render
 * inline under the input instead of failing silently.
 */

import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useEditorStore } from '@site/store/store'
import { SavedLayoutNameError } from '@site/store/slices/layoutsSlice'
import type { LayoutNameDialogRequest } from '@site/store/slices/uiSlice'
import styles from './LayoutNameDialog.module.css'

export function LayoutNameDialog() {
  const request = useEditorStore((s) => s.layoutNameDialogRequest)
  const close = useEditorStore((s) => s.closeLayoutNameDialog)
  if (!request) return null

  // Key by request identity so reopening the dialog resets the input/error
  // state without manual effects.
  const key = request.mode === 'create' ? `create:${request.nodeId}` : `rename:${request.layoutId}`
  return <LayoutNameDialogBody key={key} request={request} onClose={close} />
}

function LayoutNameDialogBody({
  request,
  onClose,
}: {
  request: LayoutNameDialogRequest
  onClose: () => void
}) {
  const saveNodeAsLayout = useEditorStore((s) => s.saveNodeAsLayout)
  const renameLayout = useEditorStore((s) => s.renameLayout)
  const currentName = useEditorStore((s) =>
    request.mode === 'rename'
      ? s.site?.layouts.find((l) => l.id === request.layoutId)?.name ?? ''
      : '',
  )
  const [name, setName] = useState(currentName)
  const [error, setError] = useState<string | null>(null)

  const isCreate = request.mode === 'create'

  function handleSubmit() {
    try {
      if (isCreate) {
        const layoutId = saveNodeAsLayout(request.nodeId, name)
        if (!layoutId) {
          setError('This element can no longer be saved as a layout.')
          return
        }
        pushToast({
          kind: 'success',
          title: `Saved layout "${name.trim()}"`,
          body: 'Find it under Layouts in the module inserter.',
          location: 'site-editor',
        })
      } else {
        renameLayout(request.layoutId, name)
      }
      onClose()
    } catch (err) {
      if (err instanceof SavedLayoutNameError) {
        setError(err.message)
      } else {
        setError(getErrorMessage(err, 'Unknown layout error'))
      }
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={isCreate ? 'Save as layout' : 'Rename layout'}
      eyebrow="Layouts"
      size="sm"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="button" onClick={handleSubmit}>
            {isCreate ? 'Save layout' : 'Rename'}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <Input
          value={name}
          placeholder="Layout name"
          aria-label="Layout name"
          autoFocus
          invalid={!!error}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSubmit()
            }
          }}
        />
        {isCreate && (
          <p className={styles.hint}>
            Saves this element and everything inside it — content, settings,
            and classes — for exact re-insertion from the module inserter.
          </p>
        )}
        {error !== null && (
          <div role="alert" className={styles.errorAlert}>
            {error}
          </div>
        )}
      </div>
    </Dialog>
  )
}
