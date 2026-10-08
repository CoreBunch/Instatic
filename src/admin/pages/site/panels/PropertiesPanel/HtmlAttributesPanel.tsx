import { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { EmptyState } from '@ui/components/EmptyState'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import {
  htmlAttributeRowsFromValue,
  htmlAttributesKey,
  htmlAttributesValueKey,
  validateHtmlAttributeRows,
  type HtmlAttributeDraftRow,
} from './htmlAttributesModel'
import styles from './HtmlAttributesPanel.module.css'
import { MODULE_GENERATED_ATTRIBUTE_NAMES } from '@core/htmlAttributes'

interface HtmlAttributesPanelProps {
  nodeId: string
  moduleId: string
  htmlAttributes: unknown
  readOnly: boolean
}

export function HtmlAttributesPanel({
  nodeId,
  moduleId,
  htmlAttributes,
  readOnly,
}: HtmlAttributesPanelProps) {
  return (
    <HtmlAttributesPanelEditor
      nodeId={nodeId}
      moduleId={moduleId}
      htmlAttributes={htmlAttributes}
      readOnly={readOnly}
    />
  )
}

function HtmlAttributesPanelEditor({
  nodeId,
  moduleId,
  htmlAttributes,
  readOnly,
}: HtmlAttributesPanelProps) {
  const updateNodeProps = useEditorStore((s) => s.updateNodeProps)
  const externalAttributesKey = htmlAttributesValueKey(htmlAttributes)
  const syncedNodeId = useRef(nodeId)
  const syncedAttributesKey = useRef(externalAttributesKey)
  const nextRowId = useRef(0)
  const [rows, setRows] = useState<HtmlAttributeDraftRow[]>(() =>
    htmlAttributeRowsFromValue(htmlAttributes)
  )

  useEffect(() => {
    if (
      syncedNodeId.current === nodeId &&
      syncedAttributesKey.current === externalAttributesKey
    ) {
      return
    }

    syncedNodeId.current = nodeId
    syncedAttributesKey.current = externalAttributesKey
    setRows(htmlAttributeRowsFromValue(htmlAttributes))
  }, [externalAttributesKey, htmlAttributes, nodeId])

  const generatedNames = MODULE_GENERATED_ATTRIBUTE_NAMES[moduleId]
  const validation = validateHtmlAttributeRows(rows, generatedNames)
  const hasRows = rows.length > 0

  function persistRows(nextRows: HtmlAttributeDraftRow[]) {
    const nextValidation = validateHtmlAttributeRows(nextRows, generatedNames)
    if (Object.keys(nextValidation.errors).length > 0) return
    const nextAttributesKey = htmlAttributesKey(nextValidation.attributes)
    if (nextAttributesKey === syncedAttributesKey.current) return
    syncedAttributesKey.current = nextAttributesKey
    updateNodeProps(nodeId, { htmlAttributes: nextValidation.attributes })
  }

  function updateRow(id: string, patch: Partial<Omit<HtmlAttributeDraftRow, 'id'>>) {
    const nextRows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
    setRows(nextRows)
    persistRows(nextRows)
  }

  function addRow() {
    nextRowId.current += 1
    setRows((current) => [
      { id: `new-${nextRowId.current}`, name: '', value: '' },
      ...current,
    ])
  }

  function removeRow(id: string) {
    const nextRows = rows.filter((row) => row.id !== id)
    setRows(nextRows)
    persistRows(nextRows)
  }

  return (
    <div className={styles.panel} data-testid="html-attributes-panel">
      <div className={styles.scroll}>
        <div className={styles.header}>
          <Button
            variant="secondary"
            size="xs"
            aria-label="Add attribute"
            onClick={addRow}
            disabled={readOnly}
          >
            <PlusIcon size={13} aria-hidden="true" />
            Add
          </Button>
        </div>

        {hasRows ? (
          <div className={styles.rows} role="list" aria-label="HTML attributes">
            {rows.map((row) => (
              <HtmlAttributeRow
                key={row.id}
                row={row}
                error={validation.errors[row.id]}
                readOnly={readOnly}
                onChange={updateRow}
                onRemove={removeRow}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <EmptyState variant="centered" title="No attributes set" />
          </div>
        )}
      </div>
    </div>
  )
}

interface HtmlAttributeRowProps {
  row: HtmlAttributeDraftRow
  error?: string
  readOnly: boolean
  onChange: (id: string, patch: Partial<Omit<HtmlAttributeDraftRow, 'id'>>) => void
  onRemove: (id: string) => void
}

function HtmlAttributeRow({
  row,
  error,
  readOnly,
  onChange,
  onRemove,
}: HtmlAttributeRowProps) {
  const errorId = `${row.id}-attribute-error`

  return (
    <div className={styles.row} role="listitem" data-invalid={error ? 'true' : undefined}>
      <div className={styles.rowGrid}>
        <Input
          fieldSize="sm"
          monospace
          value={row.name}
          placeholder="id, aria-label, data-name"
          aria-label="Attribute name"
          aria-describedby={error ? errorId : undefined}
          invalid={Boolean(error)}
          disabled={readOnly}
          spellCheck={false}
          onChange={(event) => onChange(row.id, { name: event.target.value })}
        />
        <Input
          fieldSize="sm"
          monospace
          value={row.value}
          placeholder="value"
          aria-label={`${row.name || 'Attribute'} value`}
          disabled={readOnly}
          spellCheck={false}
          onChange={(event) => onChange(row.id, { value: event.target.value })}
        />
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Remove ${row.name || 'attribute'}`}
          tooltip="Remove attribute"
          onClick={() => onRemove(row.id)}
          disabled={readOnly}
        >
          <TrashSolidIcon size={12} aria-hidden="true" />
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  )
}
