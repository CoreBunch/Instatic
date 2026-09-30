import { getAncestors, type Page } from '@core/page-tree'
import type { DataField, DataTable } from '@core/data/schemas'

/** Item schema of the closest enclosing repeater loop, if any. */
export function entryScopeRepeater(page: Page, nodeId: string, tables: readonly DataTable[]): Extract<DataField, { type: 'repeater' }> | undefined {
  const loop = [...getAncestors(page, nodeId)].reverse().find((node) => node.moduleId === 'base.loop')
  if (loop?.props.sourceId !== 'entry.field') return undefined
  const filters = loop.props.filters
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return undefined
  const fieldId = (filters as Record<string, unknown>).fieldId
  for (const table of entryScopeTables(page, loop.id, tables)) {
    const field = table.fields.find((candidate) => candidate.id === fieldId)
    if (field?.type === 'repeater') return field
  }
  return undefined
}

/** Tables represented by the entry stack at a node, following relation loops. */
export function entryScopeTables(page: Page, nodeId: string, tables: readonly DataTable[]): DataTable[] {
  const target = page.template?.target
  let scope = target?.kind === 'postTypes'
    ? tables.filter((table) => target.tableSlugs.includes(table.slug)) : []
  for (const node of getAncestors(page, nodeId)) {
    if (node.moduleId !== 'base.loop') continue
    const filters = node.props.filters
    const values = filters && typeof filters === 'object' && !Array.isArray(filters)
      ? filters as Record<string, unknown> : {}
    if (node.props.sourceId === 'data.rows') {
      scope = tables.filter((table) => table.id === values.tableId)
    } else if (node.props.sourceId === 'entry.field') {
      const targetIds = new Set(scope.flatMap((table) => {
        const field = table.fields.find((candidate) => candidate.id === values.fieldId)
        return field?.type === 'relation' && field.allowMultiple ? [field.targetTableId] : []
      }))
      scope = tables.filter((table) => targetIds.has(table.id))
    } else {
      scope = []
    }
  }
  return scope
}
