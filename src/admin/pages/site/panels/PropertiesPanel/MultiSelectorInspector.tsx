/**
 * MultiSelectorInspector — body of the Properties panel when 2+ selectors are
 * checked in the Selectors panel (the parallel of MultiSelectionInspector for
 * layers).
 *
 * It replaces the single-selector StyleSurface with a bulk action surface:
 *   - Duplicate the whole set
 *   - Apply the set to the selected canvas element (class-kind rules only)
 *   - Delete the whole set (confirmed)
 * Below the action bar, every selected selector is listed with its full
 * selector label and an X that removes JUST that rule from the multi-set.
 *
 * Locked utility rules can't be duplicated, applied as a class attribute, or
 * deleted — the bulk store actions skip them, so the buttons stay enabled for
 * the rest of the set and the locked rules are simply left untouched.
 */

import { useEditorStore, selectSelectedNode } from '@site/store/store'
import { styleRuleSelector } from '@core/page-tree'
import { isGeneratedClassLocked } from '@core/page-tree'
import type { StyleRule } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import {
  TreeRow,
  TreeLabel,
  TreeLabelGroup,
} from '@site/ui/Tree'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { RemoveXGlyph } from '@ui/icons/inspectorGlyphs'
import styles from './MultiSelectorInspector.module.css'

interface MultiSelectorInspectorProps {
  /** Checkbox multi-selection set from the Selectors panel. Contains 1+ ids. */
  selectedSelectorClassIds: string[]
}

export function MultiSelectorInspector({
  selectedSelectorClassIds,
}: MultiSelectorInspectorProps) {
  const styleRules = useEditorStore((s) => s.site?.styleRules)
  const selectedNode = useEditorStore(selectSelectedNode)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const duplicateClasses = useEditorStore((s) => s.duplicateClasses)
  const deleteClasses = useEditorStore((s) => s.deleteClasses)
  const addNodeClasses = useEditorStore((s) => s.addNodeClasses)
  const toggleSelectorMultiSelect = useEditorStore((s) => s.toggleSelectorMultiSelect)
  const setSelectedSelectorClassIds = useEditorStore((s) => s.setSelectedSelectorClassIds)

  // Resolve each id to its rule against the live registry. A missing id (rule
  // deleted underneath us) renders as a non-actionable "(missing)" row.
  const rows = selectedSelectorClassIds.map((id) => {
    const cls = styleRules?.[id] ?? null
    return {
      id,
      cls,
      label: cls ? styleRuleSelector(cls) : '(missing)',
    }
  })

  const resolved = rows
    .map((row) => row.cls)
    .filter((cls): cls is StyleRule => cls !== null)

  // Class-kind rules the selected element doesn't already have are what "Apply"
  // can attach. Locked generated utilities (e.g. `text-primary-5`) ARE
  // applicable — "locked" only blocks rename/delete, not assignment, and
  // applying utilities to elements is their whole purpose. Only ambient rules
  // (`h1 > span`) are excluded: they match by selector, not class attribute.
  const applicableToNode = selectedNodeId
    ? resolved.filter(
        (cls) =>
          (!cls.kind || cls.kind === 'class') &&
          !(selectedNode?.classIds?.includes(cls.id) ?? false),
      )
    : []

  // Locked generated utilities can't be duplicated or deleted (same guard the
  // per-row context menu and the singular store actions enforce). Duplicate /
  // Delete only act on the editable subset, and disable when none qualify.
  const editable = resolved.filter((cls) => !isGeneratedClassLocked(cls))
  const editableIds = editable.map((cls) => cls.id)

  const confirmDelete = useConfirmDelete()

  const handleDuplicate = () => {
    const copies = duplicateClasses(editableIds)
    // Move the multi-selection onto the new copies so the result is visible.
    if (copies.length > 0) {
      setSelectedSelectorClassIds(copies.map((copy) => copy.id))
    }
  }

  const handleApplyToNode = () => {
    if (!selectedNodeId) return
    // One batched mutation → a single undo step removes the whole apply.
    addNodeClasses(selectedNodeId, applicableToNode.map((cls) => cls.id))
  }

  const handleDelete = () => {
    const count = editableIds.length
    if (count === 0) return
    confirmDelete({
      title: 'Delete selectors?',
      description: `${count} ${count === 1 ? 'selector' : 'selectors'} will be removed from every element that uses them. This can be undone with Ctrl/Cmd+Z.`,
      confirmLabel: 'Delete',
      commit: () => deleteClasses(editableIds),
    })
  }

  return (
    <div className={styles.root}>
      <div className={styles.actionBar} role="group" aria-label="Multi-select selector actions">
        <div className={styles.actionRow}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDuplicate}
            disabled={editableIds.length === 0}
            tooltip={
              editableIds.length === 0
                ? 'Locked utility selectors can’t be duplicated'
                : 'Duplicate selected selectors'
            }
          >
            <CopySolidIcon size={13} aria-hidden="true" />
            Duplicate
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleApplyToNode}
            disabled={applicableToNode.length === 0}
            tooltip={
              selectedNodeId
                ? 'Apply selected selectors to the selected element'
                : 'Select an element on the canvas first'
            }
          >
            <PaintBucketSolidIcon size={13} aria-hidden="true" />
            Apply
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDelete}
            disabled={editableIds.length === 0}
            tooltip={
              editableIds.length === 0
                ? 'Locked utility selectors can’t be deleted'
                : 'Delete selected selectors'
            }
          >
            <TrashSolidIcon size={13} aria-hidden="true" />
            Delete
          </Button>
        </div>
      </div>

      <div className={styles.listHeader}>
        Selected selectors ({selectedSelectorClassIds.length})
      </div>
      <div className={styles.list} role="list">
        {rows.map((row) => (
          <TreeRow key={row.id} depth={0} role="listitem" className={styles.row}>
            <TreeLabelGroup>
              <TreeLabel>{row.label}</TreeLabel>
            </TreeLabelGroup>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              onClick={() => toggleSelectorMultiSelect(row.id)}
              aria-label={`Remove ${row.label} from selection`}
              tooltip="Remove from selection"
            >
              <RemoveXGlyph />
            </Button>
          </TreeRow>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MultiSelectorHeader — replaces the selector-name header in the panel header
// when a multi-selection is active. Static "N selectors selected" chip.
// ---------------------------------------------------------------------------

interface MultiSelectorHeaderProps {
  count: number
}

export function MultiSelectorHeader({ count }: MultiSelectorHeaderProps) {
  return <span>{count} {count === 1 ? 'selector' : 'selectors'} selected</span>
}
