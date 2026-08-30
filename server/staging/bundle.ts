import type { DbClient } from '../db/client'
import { getDraftSite } from '../repositories/site'
import { listDataTables } from '../repositories/data/tables'
import { listDataRows } from '../repositories/data/rows'
import { listExportableRedirects } from '../repositories/data/publish'
import type { SiteBundle } from '@core/data/bundleSchema'

export async function buildStagingBundle(
  db: DbClient,
  input: { tableIds: readonly string[]; includeSite: boolean },
): Promise<SiteBundle> {
  const shell = await getDraftSite(db)
  if (!shell) throw new Error('Site is not initialized.')

  const requested = input.tableIds.length > 0 ? new Set(input.tableIds) : null
  const tables = (await listDataTables(db)).filter((table) => !requested || requested.has(table.id))
  const rows = (await Promise.all(tables.map((table) => listDataRows(db, table.id)))).flat()
  const tableIds = new Set(tables.map((table) => table.id))
  const rowIds = new Set(rows.map((row) => row.id))
  const redirects = (await listExportableRedirects(db)).filter(
    (redirect) => tableIds.has(redirect.tableId) && rowIds.has(redirect.targetRowId),
  )

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceSiteName: shell.name,
    ...(input.includeSite ? { site: shell } : {}),
    tables,
    rows,
    redirects,
  }
}
