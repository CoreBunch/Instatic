import { entryFieldContextKey, resolveEntryFieldItems, type LoopItem } from '@core/loops'
import { fetchPublishedDataRowItems } from '@core/loops/sources/dataRows'
import { logicalIdOf, physicalId, MAIN_BRANCH_ID } from '@core/branches'
import type { DbClient } from '../db/client'
import { getDataTable } from '../repositories/data'

/** Resolve only the relation traversed by this layout node, in table-sized batches. */
export async function prefetchRelationLoopItems(
  db: DbClient,
  parents: readonly LoopItem[],
  fieldId: string,
  options: { branchId?: string; drafts?: boolean; offset: number; limit: number; direction: 'asc' | 'desc' },
): Promise<Map<string, LoopItem[]>> {
  const branchId = options.branchId ?? MAIN_BRANCH_ID
  const groups = new Map<string, LoopItem[]>()
  for (const parent of parents) {
    const tableId = parent.fields.tableId
    if (typeof tableId !== 'string') continue
    const group = groups.get(tableId) ?? []
    group.push(parent)
    groups.set(tableId, group)
  }
  const result = new Map<string, LoopItem[]>()
  for (const [tableId, entries] of groups) {
    const table = await getDataTable(db, { branchId }, logicalIdOf(branchId, tableId))
    const field = table?.fields.find((candidate) => candidate.id === fieldId)
    if (field?.type !== 'relation' || !field.allowMultiple) continue
    const ids = new Set<string>()
    for (const entry of entries) {
      const value = entry.fields[fieldId]
      if (Array.isArray(value)) for (const id of value) if (typeof id === 'string') ids.add(id)
    }
    const target = await fetchPublishedDataRowItems(db, {
      tableId: physicalId(branchId, logicalIdOf(branchId, field.targetTableId)),
      rowIds: [...ids],
      drafts: options.drafts ?? branchId !== MAIN_BRANCH_ID,
      orderBy: 'slug', direction: 'asc', limit: ids.size, offset: 0,
    })
    const relatedItems = new Map(target.items.map((item) => [item.id, item]))
    for (const entry of entries) {
      result.set(entryFieldContextKey(entry), resolveEntryFieldItems(entry.fields[fieldId], {
        ...options, relatedItems,
      }).items)
    }
  }
  return result
}
