import type { Page } from '@core/page-tree'
import { collectDataBindingRowIds } from '@core/templates'
import type { DbClient } from '../db/client'
import { getGlobalDataBindingRows } from '../repositories/data'

export async function prefetchGlobalDataBindings(
  pages: readonly Page[],
  db: DbClient,
): Promise<Record<string, Record<string, unknown>>> {
  const rowIds = collectDataBindingRowIds(pages)
  if (rowIds.length === 0) return {}
  const rows = await getGlobalDataBindingRows(db, rowIds)
  return Object.fromEntries(rows.map((row) => [row.rowId, row.cells]))
}
