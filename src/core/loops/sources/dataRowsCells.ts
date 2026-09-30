import { readMediaCellIds, readRepeaterCell } from '@core/data/cells'
import type { DataField, DataRowCells, RepeaterItemField } from '@core/data/schemas'

/** Select cells store option IDs; repeater bindings should show their labels. */
function repeaterChoiceLabels(cells: DataRowCells, fields: readonly RepeaterItemField[]): DataRowCells {
  const overlay: DataRowCells = {}
  for (const field of fields) {
    if (field.type !== 'select' && field.type !== 'multiSelect') continue
    const label = (value: unknown) => {
      if (typeof value !== 'string') return ''
      return field.options.find((option) => option.id === value || option.value === value)?.label ?? value
    }
    const value = cells[field.id]
    overlay[field.id] = field.type === 'multiSelect'
      ? (Array.isArray(value) ? value.map(label) : [])
      : label(value)
  }
  return overlay
}

/**
 * Resolve schema-declared media ids without changing collection cardinality:
 * scalar media becomes a public path (or null), multi-media stays an ordered
 * array of resolvable public paths, and repeater items keep their `{ id, cells }`
 * shape while media and select labels inside `cells` are projected.
 */
export function resolvedCellOverlay(
  cells: DataRowCells,
  fields: readonly DataField[],
  mediaPathMap: Map<string, string>,
): DataRowCells {
  const overlay: DataRowCells = {}
  for (const field of fields) {
    if (field.type === 'media') {
      const ids = readMediaCellIds(cells, field.id)
      if (field.allowMultiple === true) {
        overlay[field.id] = ids.flatMap((id) => {
          const path = mediaPathMap.get(id)
          return path ? [path] : []
        })
      } else {
        const id = ids[0]
        overlay[field.id] = id ? (mediaPathMap.get(id) ?? null) : null
      }
      continue
    }
    if (field.type !== 'repeater') continue
    overlay[field.id] = readRepeaterCell(cells, field.id).map((item) => ({
      ...item,
      cells: {
        ...item.cells,
        ...resolvedCellOverlay(item.cells, field.fields, mediaPathMap),
        ...repeaterChoiceLabels(item.cells, field.fields),
      },
    }))
  }
  return overlay
}
