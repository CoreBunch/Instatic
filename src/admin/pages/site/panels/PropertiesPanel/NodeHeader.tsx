/**
 * NodeHeader — selected element name with inline rename, rendered inside the
 * Properties panel header (Guideline #221).
 *
 * Renaming a node mutates `node.label`, which is a structural change — the
 * pencil button is hidden for callers without `site.structure.edit`.
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { CanvasTreeLadderMenu } from '@site/canvas/CanvasTreeLadderMenu'
import { CornerDownLeftIcon } from 'pixel-art-icons/icons/corner-down-left'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import styles from './PropertiesPanel.module.css'

interface NodeHeaderProps {
  nodeId: string
  label: string | undefined
  moduleName: string
  /**
   * The HTML element this node renders as (`section`, `nav`, …), or null for
   * modules with no single deterministic root. The prototype's `.panel-head`
   * closes with it: the name says what the author called this thing, the tag
   * says what it actually is in the document.
   */
  htmlTag: string | null
  onRename: (label: string) => void
}

export function NodeHeader({ nodeId, label, moduleName, htmlTag, onRename }: NodeHeaderProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [layerMenuOpen, setLayerMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const layerMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const displayName = label ?? moduleName
  // Renaming a node mutates `node.label` — a structural change, not content.
  const canRename = useEditorPermissions().canEditStructure

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.value = displayName
    }
  }, [nodeId, displayName, isEditing])

  useEffect(() => {
    if (!isEditing) return
    requestAnimationFrame(() => inputRef.current?.select())
  }, [isEditing])

  const commitRename = (input: HTMLInputElement) => {
    const nextLabel = input.value.trim()
    if (nextLabel && nextLabel !== displayName) {
      onRename(nextLabel)
    } else {
      input.value = displayName
    }
    setIsEditing(false)
  }

  const cancelRename = (input: HTMLInputElement) => {
    input.value = displayName
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        type="text"
        fieldSize="xs"
        emphasis="strong"
        defaultValue={displayName}
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
        aria-label="Element name"
        className={styles.headerNameInput}
      />
    )
  }

  return (
    <div className={styles.headerNodeTitle}>
      <Button
        ref={layerMenuTriggerRef}
        variant="ghost"
        size="xs"
        iconOnly
        aria-haspopup="menu"
        aria-expanded={layerMenuOpen}
        aria-label={`Select parent or child layer for ${displayName}`}
        tooltip="Select parent or child layer"
        onClick={() => setLayerMenuOpen((open) => !open)}
      >
        <CornerDownLeftIcon size={12} className={styles.headerLayerMenuIcon} aria-hidden="true" />
      </Button>
      <span className={styles.headerNodeLabel} title={displayName}>{displayName}</span>
      {canRename && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          onClick={() => setIsEditing(true)}
          aria-label={`Rename ${displayName}`}
          tooltip="Rename element"
        >
          <EditSolidIcon size={12} aria-hidden="true" />
        </Button>
      )}
      {htmlTag && (
        <span className={styles.headerNodeTag} title={`Renders as <${htmlTag}>`}>
          {htmlTag}
        </span>
      )}
      {layerMenuOpen && (
        <CanvasTreeLadderMenu
          anchorRef={layerMenuTriggerRef}
          triggerRef={layerMenuTriggerRef}
          nodeId={nodeId}
          onClose={() => setLayerMenuOpen(false)}
        />
      )}
    </div>
  )
}
