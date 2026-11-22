/**
 * SelectorHeader — global class selector name (e.g. `.button-primary`) with
 * inline rename, rendered inside the Properties panel header when the user
 * has selected a class via the Selectors panel.
 *
 * Renaming or deleting a selector is a style edit — the action buttons are
 * hidden for callers without `site.style.edit`. Generated utility classes are
 * locked and cannot be renamed or deleted, so the actions are hidden for them.
 */
import { useMobileViewport } from '@admin/lib/mobileViewport'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { isGeneratedClassLocked, styleRuleSelector } from '@core/page-tree'
import type { StyleRule } from '@core/page-tree'
import { DeleteSelectorDialog } from '../SelectorDialogs'
import styles from './PropertiesPanel.module.css'

interface SelectorHeaderProps {
  cls: StyleRule
  usage: string | null
  onRename: (name: string) => void
  onDelete: () => void
}

export function SelectorHeader({ cls, usage, onRename, onDelete }: SelectorHeaderProps) {
  const phone = useMobileViewport()
  const [isEditing, setIsEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectorLabel = styleRuleSelector(cls)
  const isAmbient = cls.kind === 'ambient'
  // Selector changes are style edits. Generated utility classes are locked and
  // cannot be renamed or deleted from the editor.
  const canEditSelector = useEditorPermissions().canEditStyle && !isGeneratedClassLocked(cls)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.value = selectorLabel
    }
  }, [cls.id, selectorLabel, isEditing])

  useEffect(() => {
    if (!isEditing) return
    requestAnimationFrame(() => inputRef.current?.select())
  }, [isEditing])

  const commitRename = (input: HTMLInputElement) => {
    const rawName = input.value.trim()
    const nextName = isAmbient
      ? rawName
      : (rawName.startsWith('.') ? rawName.slice(1) : rawName).trim()
    const currentName = isAmbient ? selectorLabel : cls.name
    if (nextName && nextName !== currentName) {
      try {
        onRename(nextName)
      } catch {
        input.value = selectorLabel
      }
    } else {
      input.value = selectorLabel
    }
    setIsEditing(false)
  }

  const cancelRename = (input: HTMLInputElement) => {
    input.value = selectorLabel
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        type="text"
        fieldSize="xs"
        emphasis="strong"
        defaultValue={selectorLabel}
        onBlur={(e) => commitRename(e.target)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            cancelRename(e.target as HTMLInputElement)
          }
        }}
        aria-label={isAmbient ? 'Selector' : 'Class name'}
        className={styles.headerNameInput}
      />
    )
  }

  return (
    <>
      <div className={styles.headerNodeTitle}>
        <h2 className={styles.headerNodeLabel} title={selectorLabel}>{selectorLabel}</h2>
        {canEditSelector && (
          <>
            <Button
              variant="ghost"
              size={phone ? 'md' : 'xs'}
              iconOnly
              onClick={() => setIsEditing(true)}
              aria-label={`Rename selector ${selectorLabel}`}
              tooltip="Rename selector"
            >
              <EditSolidIcon size={12} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size={phone ? 'md' : 'xs'}
              iconOnly
              dangerHover
              onClick={() => setConfirmingDelete(true)}
              aria-label={`Delete selector ${selectorLabel}`}
              tooltip="Delete selector"
            >
              <TrashSolidIcon size={12} aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
      {confirmingDelete && (
        <DeleteSelectorDialog
          cls={cls}
          usage={usage}
          onCancel={() => setConfirmingDelete(false)}
          onDelete={onDelete}
        />
      )}
    </>
  )
}
