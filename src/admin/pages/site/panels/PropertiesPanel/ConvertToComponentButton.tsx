/**
 * ConvertToComponentButton — inline control to convert a page node into a Visual Component.
 *
 * Two states:
 *   idle    → single "Componentize" Button (secondary, full-width).
 *   editing → inline Input + Create + Cancel strip with inline error display.
 *
 * Visibility is gated by the parent (PropertiesPanel) — this component is
 * rendered only on pages, for non-root, non-ref selected nodes.
 *
 * Architecture source: Contribution #619 Phase 3 §3
 * Constraint #269: may import from core/
 */

import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { VisualComponentNameError } from '@site/store/slices/vcTreeOps'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import styles from './ConvertToComponentButton.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ConvertToComponentButtonProps {
  nodeId: string
}

// ---------------------------------------------------------------------------
// ConvertToComponentButton
// ---------------------------------------------------------------------------

export function ConvertToComponentButton({ nodeId }: ConvertToComponentButtonProps) {
  const [manualEditing, setManualEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const convertNodeToComponent = useEditorStore((s) => s.convertNodeToComponent)
  const componentizeEditorRequest = useEditorStore((s) => s.componentizeEditorRequest)
  const clearComponentizeEditorRequest = useEditorStore((s) => s.clearComponentizeEditorRequest)
  const requestForThisNode =
    componentizeEditorRequest?.nodeId === nodeId ? componentizeEditorRequest : null
  const editing = manualEditing || requestForThisNode !== null

  useEffect(() => {
    if (!requestForThisNode) return
    requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
  }, [requestForThisNode])

  function handleSubmit() {
    const name = inputRef.current?.value.trim() ?? ''
    if (!name) return
    try {
      convertNodeToComponent(nodeId, name)
      if (requestForThisNode) {
        clearComponentizeEditorRequest(requestForThisNode.requestId)
      }
      // On success: activeDocument switches to the new VC, panel rerenders,
      // this component unmounts — no further local state update needed.
    } catch (err) {
      if (err instanceof VisualComponentNameError) {
        setError(err.message)
      } else {
        setError(`Failed to convert: ${getErrorMessage(err, 'Unknown error')}`)
      }
    }
  }

  if (!editing) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setManualEditing(true)
          setError(null)
          requestAnimationFrame(() => {
            inputRef.current?.focus()
          })
        }}
      >
        Componentize
      </Button>
    )
  }

  // Editing state — span the full parent row so the inline Input + Create +
  // Cancel strip is not crammed into a half-column.
  return (
    <div className={styles.editingStrip}>
      <div className={styles.inputRow}>
        <Input
          ref={inputRef}
          fieldSize="sm"
          defaultValue=""
          placeholder="Component name"
          autoFocus
          aria-label="Component name"
          invalid={!!error}
          onChange={() => {
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleSubmit()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setManualEditing(false)
              setError(null)
              if (requestForThisNode) {
                clearComponentizeEditorRequest(requestForThisNode.requestId)
              }
            }
          }}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
        >
          Create
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setManualEditing(false)
            setError(null)
            if (requestForThisNode) {
              clearComponentizeEditorRequest(requestForThisNode.requestId)
            }
          }}
        >
          Cancel
        </Button>
      </div>
      {error !== null && (
        <div role="alert" className={styles.errorAlert}>
          {error}
        </div>
      )}
    </div>
  )
}
