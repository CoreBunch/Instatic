/**
 * PageTreeCell — cell renderer for `pageTree` fields.
 *
 * A `pageTree` cell stores a full `NodeTree<PageNode>` — the visual editor
 * tree for a page or component row. The cell does not render the tree inline;
 * it renders an "Open editor →" button that the parent can wire to navigate
 * into the visual editor for that row.
 *
 * The optional `onOpenEditor` prop follows the same extra-prop threading
 * pattern that `RelationCell` uses for `onOpenPicker`.
 *
 * `readOnly` deliberately does NOT gate the button. It means "this value is
 * not editable in the grid", which is always true for a `pageTree` cell on a
 * system table (`isBuiltInValueLocked` holds for every built-in field of
 * `pages` / `components` / `layouts`). The button edits nothing — it navigates
 * to the visual editor, which enforces its own permissions. Gating it on
 * `readOnly` disabled it on exactly the rows it exists for.
 */
import type { ReactElement } from 'react'
import { Button } from '@ui/components/Button'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import type { CellEditorProps } from '@admin/pages/data/types'
import type { DataField } from '@core/data/schemas'
import { readNodeTreeCell } from '@core/data/cells'
import styles from './cells.module.css'

type PageTreeField = Extract<DataField, { type: 'pageTree' }>

export interface PageTreeCellProps extends CellEditorProps<PageTreeField> {
  /** Called when the user wants to open the visual editor for this row. */
  onOpenEditor?: () => void
}

export function PageTreeCell({
  field,
  value,
  ariaLabel,
  onOpenEditor,
}: PageTreeCellProps): ReactElement {
  // Resolve from the raw cell value — the cell stores NodeTree<PageNode>.
  const tree = readNodeTreeCell({ [field.id]: value }, field.id)
  const hasTree = tree !== null

  return (
    <div className={styles.relationButton}>
      <Button
        variant="secondary"
        size="sm"
        disabled={!onOpenEditor}
        aria-label={ariaLabel ?? `${field.label}: ${hasTree ? 'Open editor' : 'No content'}`}
        onClick={() => onOpenEditor?.()}
        align="start"
        fullWidth
      >
        <LayoutSolidIcon size={14} />
        {hasTree ? (
          <span>Open editor →</span>
        ) : (
          <span className={styles.relationEmpty}>No content</span>
        )}
      </Button>
    </div>
  )
}
