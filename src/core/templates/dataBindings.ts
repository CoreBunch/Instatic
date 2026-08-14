/**
 * Discover custom-data rows referenced by a page tree.
 *
 * Data bindings persist immutable row ids in paths shaped
 * `<rowId>.<fieldId>`. Keeping discovery in the template engine gives the
 * editor and publisher one definition of which rows must be prefetched.
 */

import type { Page } from '@core/page-tree'
import { parseTokenString } from './tokenInterpolation'

export function dataBindingRowId(fieldPath: string): string | null {
  const separator = fieldPath.indexOf('.')
  if (separator <= 0 || separator === fieldPath.length - 1) return null
  return fieldPath.slice(0, separator)
}

function collectTokenRows(value: unknown, rowIds: Set<string>): void {
  if (typeof value === 'string') {
    for (const segment of parseTokenString(value)) {
      if (segment.kind !== 'token' || segment.source !== 'data') continue
      const rowId = dataBindingRowId(segment.field)
      if (rowId) rowIds.add(rowId)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTokenRows(entry, rowIds)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectTokenRows(entry, rowIds)
  }
}

export function collectDataBindingRowIds(pages: readonly Page[]): string[] {
  const rowIds = new Set<string>()
  for (const page of pages) {
    for (const node of Object.values(page.nodes)) {
      for (const binding of Object.values(node.dynamicBindings ?? {})) {
        if (binding.source !== 'data') continue
        const rowId = dataBindingRowId(binding.field)
        if (rowId) rowIds.add(rowId)
      }
      collectTokenRows(node.props, rowIds)
    }
  }
  return [...rowIds].sort()
}
