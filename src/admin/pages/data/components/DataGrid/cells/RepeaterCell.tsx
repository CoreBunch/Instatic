import { useState, type ReactElement } from 'react'
import { nanoid } from 'nanoid'
import { Button } from '@ui/components/Button'
import { ArrowUpIcon } from 'pixel-art-icons/icons/arrow-up'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { ChevronUpIcon } from 'pixel-art-icons/icons/chevron-up'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { readRepeaterCell } from '@core/data/cells'
import type {
  DataField,
  DataTable,
  RepeaterItem,
  RepeaterItemField,
} from '@core/data/schemas'
import type { CellEditorProps } from '@admin/pages/data/types'
import { emptyCellValue } from '@admin/pages/data/utils/fieldDefaults'
import { readableRepeaterSummaryValue } from '@admin/pages/data/utils/repeaterSummary'
import { RelationPickerDialog } from '@admin/pages/data/components/RelationPickerDialog/RelationPickerDialog'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { MediaRepeaterGallery } from './MediaRepeaterGallery'
import { RepeaterItemCellEditor } from './RepeaterItemCellEditor'
import styles from './cells.module.css'

type RepeaterField = Extract<DataField, { type: 'repeater' }>

export interface RepeaterCellProps extends CellEditorProps<RepeaterField> {
  tables?: DataTable[]
}

interface RelationPickerState {
  itemId: string
  field: Extract<RepeaterItemField, { type: 'relation' }>
}

function buildItem(field: RepeaterField): RepeaterItem {
  return {
    id: nanoid(),
    cells: Object.fromEntries(field.fields.map((itemField) => [
      itemField.id,
      emptyCellValue(itemField),
    ])),
  }
}

function itemSummary(item: RepeaterItem, field: RepeaterField, index: number): string {
  if (field.itemLabelFieldId) {
    const preferredField = field.fields.find((itemField) => itemField.id === field.itemLabelFieldId)
    return (preferredField && readableRepeaterSummaryValue(
      preferredField,
      item.cells[preferredField.id],
    )) || `Item ${index + 1}`
  }

  for (const itemField of field.fields) {
    const summary = readableRepeaterSummaryValue(itemField, item.cells[itemField.id])
    if (summary) return summary
  }
  return `Item ${index + 1}`
}

export function RepeaterCell({
  field,
  value,
  onChange,
  onCommit,
  readOnly,
  rowId,
  resolveRelationTarget,
  tables = [],
}: RepeaterCellProps): ReactElement {
  const confirmDelete = useConfirmDelete()
  const items = readRepeaterCell({ [field.id]: value }, field.id)
  const [relationPicker, setRelationPicker] = useState<RelationPickerState | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(items[0] ? [items[0].id] : []),
  )

  function commitItems(nextItems: RepeaterItem[], immediate = true) {
    onChange(nextItems)
    if (immediate) onCommit?.()
  }

  function updateItemCell(itemId: string, fieldId: string, next: unknown) {
    commitItems(items.map((item) => item.id === itemId
      ? { ...item, cells: { ...item.cells, [fieldId]: next } }
      : item,
    ), false)
  }

  function moveItem(index: number, offset: -1 | 1) {
    const target = index + offset
    if (target < 0 || target >= items.length) return
    const next = [...items]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    commitItems(next)
  }

  function toggleItem(itemId: string) {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const pickerTargetTable = relationPicker
    ? tables.find((table) => table.id === relationPicker.field.targetTableId) ?? null
    : null
  const pickerItem = relationPicker
    ? items.find((item) => item.id === relationPicker.itemId)
    : undefined
  const pickerValue = relationPicker && pickerItem
    ? (pickerItem.cells[relationPicker.field.id] as string | string[] | null | undefined) ?? null
    : null

  const mediaField = field.fields.length === 1 && field.fields[0]?.type === 'media'
    && field.fields[0].allowMultiple !== true
    ? field.fields[0]
    : null

  if (mediaField) {
    return (
      <MediaRepeaterGallery
        field={field}
        mediaField={mediaField}
        items={items}
        readOnly={readOnly}
        onChange={(nextItems) => onChange(nextItems)}
        onCommit={onCommit}
      />
    )
  }

  return (
    <div className={styles.repeaterEditor}>
      <div className={styles.repeaterToolbar}>
        <span className={styles.repeaterHeading}>
          <span className={styles.repeaterLabel}>{field.label}</span>
          <span className={styles.repeaterCount}>
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </span>
        </span>
        {!readOnly && (
          <Button
            variant="secondary"
            size="xs"
            type="button"
            onClick={() => {
              const item = buildItem(field)
              setExpandedIds((current) => new Set([...current, item.id]))
              commitItems([...items, item])
            }}
          >
            <PlusIcon size={11} aria-hidden="true" />
            Add item
          </Button>
        )}
      </div>
      {field.description && (
        <span className={styles.repeaterDescription}>{field.description}</span>
      )}

      {items.length === 0 ? (
        <div className={styles.repeaterEmptyState}>
          <span>No items yet</span>
          <span>Add one structured item, then repeat as needed.</span>
        </div>
      ) : (
        <div className={styles.repeaterItems}>
          {items.map((item, index) => (
            <section key={item.id} className={styles.repeaterItem}>
              <header className={styles.repeaterItemHeader}>
                <span className={styles.repeaterItemNumber}>{index + 1}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  type="button"
                  align="start"
                  pressed={expandedIds.has(item.id)}
                  aria-label={`${expandedIds.has(item.id) ? 'Collapse' : 'Expand'} ${itemSummary(item, field, index)}`}
                  onClick={() => toggleItem(item.id)}
                  className={styles.repeaterItemDisclosure}
                >
                  <span className={styles.repeaterItemSummary}>
                    {itemSummary(item, field, index)}
                  </span>
                  {expandedIds.has(item.id)
                    ? <ChevronUpIcon size={11} aria-hidden="true" />
                    : <ChevronDownIcon size={11} aria-hidden="true" />}
                </Button>
                {!readOnly && (
                  <span className={styles.repeaterItemActions}>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      type="button"
                      aria-label={`Move item ${index + 1} up`}
                      tooltip="Move up"
                      disabled={index === 0}
                      onClick={() => moveItem(index, -1)}
                    >
                      <ArrowUpIcon size={11} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      type="button"
                      aria-label={`Move item ${index + 1} down`}
                      tooltip="Move down"
                      disabled={index === items.length - 1}
                      onClick={() => moveItem(index, 1)}
                    >
                      <ArrowDownIcon size={11} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      type="button"
                      aria-label={`Duplicate item ${index + 1}`}
                      tooltip="Duplicate"
                      onClick={() => {
                        const duplicateId = nanoid()
                        const next = [...items]
                        next.splice(index + 1, 0, {
                          id: duplicateId,
                          cells: structuredClone(item.cells),
                        })
                        setExpandedIds((current) => new Set([...current, duplicateId]))
                        commitItems(next)
                      }}
                    >
                      <CopySolidIcon size={11} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      tone="danger"
                      type="button"
                      aria-label={`Delete item ${index + 1}`}
                      tooltip="Delete item"
                      onClick={() => {
                        confirmDelete({
                          title: `Delete "${itemSummary(item, field, index)}"?`,
                          description: 'This removes the item and every value inside it.',
                          alwaysConfirm: true,
                          commit: () => {
                            setExpandedIds((current) => {
                              const next = new Set(current)
                              next.delete(item.id)
                              return next
                            })
                            commitItems(items.filter((candidate) => candidate.id !== item.id))
                          },
                        })
                      }}
                    >
                      <TrashSolidIcon size={11} aria-hidden="true" />
                    </Button>
                  </span>
                )}
              </header>

              {expandedIds.has(item.id) && (
                <div className={styles.repeaterItemFields}>
                  {field.fields.map((itemField) => (
                    <div key={itemField.id} className={styles.repeaterItemField}>
                      <span>{itemField.label}</span>
                      {itemField.description && <small>{itemField.description}</small>}
                      <RepeaterItemCellEditor
                        field={itemField}
                        value={item.cells[itemField.id] ?? emptyCellValue(itemField)}
                        onChange={(next) => updateItemCell(item.id, itemField.id, next)}
                        onCommit={onCommit}
                        context="detail"
                        readOnly={readOnly}
                        rowId={rowId}
                        resolveRelationTarget={resolveRelationTarget}
                        onOpenPicker={itemField.type === 'relation'
                          ? () => setRelationPicker({ itemId: item.id, field: itemField })
                          : undefined}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      {relationPicker && (
        <RelationPickerDialog
          open
          onClose={() => setRelationPicker(null)}
          targetTable={pickerTargetTable}
          currentValue={pickerValue}
          allowMultiple={relationPicker.field.allowMultiple ?? false}
          onPick={(next) => {
            updateItemCell(relationPicker.itemId, relationPicker.field.id, next)
            onCommit?.()
            setRelationPicker(null)
          }}
        />
      )}
    </div>
  )
}
