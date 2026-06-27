import { nanoid } from 'nanoid'
import type { DataField, DataRowCells } from '@core/data/schemas'

/**
 * Returns the canonical empty / default cell value for a given field type.
 */
export function emptyCellValue(field: DataField): unknown {
  switch (field.type) {
    case 'text':
    case 'longText':
    case 'richText':
    case 'url':
    case 'email':
    case 'date':
    case 'dateTime':
    case 'select':
      return ''
    case 'number':
      return null
    case 'boolean':
      return field.defaultValue ?? false
    case 'multiSelect':
      return []
    case 'media':
      return field.allowMultiple ? [] : null
    case 'relation':
      return field.allowMultiple ? [] : null

    case 'pageTree': {
      // Minimal valid NodeTree with a single root `base.body` node.
      const rootId = nanoid()
      return {
        nodes: {
          [rootId]: {
            id: rootId,
            moduleId: 'base.body',
            props: {},
            children: [],
            classIds: [],
          },
        },
        rootNodeId: rootId,
      }
    }

    case 'fieldSchema':
      return []

    case 'seoMetadata':
      return {}

    default: {
      const _exhaustive: never = field
      void _exhaustive
      return null
    }
  }
}

/**
 * Builds a `DataRowCells` record with every field initialised to its
 * canonical empty value. Always includes a `slug: ''` key so that row
 * PATCH requests always carry one.
 */
export function buildEmptyCells(fields: DataField[]): DataRowCells {
  const cells: DataRowCells = {}

  for (const field of fields) {
    cells[field.id] = emptyCellValue(field)
  }

  // Ensure slug is always present even when no explicit slug field exists.
  if (!('slug' in cells)) {
    cells['slug'] = ''
  }

  return cells
}
