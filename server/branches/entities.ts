/**
 * The mergeable entities of a branch — the site shell, every site file,
 * every table, every row — in one keyed map, with the content projection the merge compares
 * and hashes. Shared by fork (to record bases) and merge (to plan).
 */
import { SITE_SHELL_LOGICAL_ID } from '@core/branches'
import type { DataRow, DataTable } from '@core/data/schemas'
import type { DbClient } from '../db/client'
import type { BranchScope } from './scope'
import { fileContent, rowContent, siteContent, tableContent, type BranchEntityKind } from './contentHash'
import { listDataRows, listDataTables } from '../repositories/data'
import { getDraftSite } from '../repositories/site'

export interface BranchEntity {
  kind: BranchEntityKind
  logicalId: string
  label: string
  /** Logical id of the row's table; null for tables and the shell. */
  tableId: string | null
  tableName: string | null
  content: unknown
}

export const SITE_ENTITY_KEY = `site:${SITE_SHELL_LOGICAL_ID}`

export function entityKey(kind: BranchEntityKind, logicalId: string): string {
  return `${kind}:${logicalId}`
}

function rowLabel(row: DataRow, table: DataTable): string {
  const title = row.cells[table.primaryFieldId] ?? row.cells.title
  if (typeof title === 'string' && title.trim()) return title.trim()
  return row.slug || row.id
}

export async function collectBranchEntities(db: DbClient, scope: BranchScope): Promise<Map<string, BranchEntity>> {
  const entities = new Map<string, BranchEntity>()
  const shell = await getDraftSite(db, scope)
  if (shell) {
    entities.set(SITE_ENTITY_KEY, {
      kind: 'site',
      logicalId: SITE_SHELL_LOGICAL_ID,
      label: 'Site settings',
      tableId: null,
      tableName: null,
      content: siteContent(shell),
    })
    for (const file of shell.files) {
      entities.set(entityKey('file', file.id), {
        kind: 'file',
        logicalId: file.id,
        label: file.path,
        tableId: null,
        tableName: null,
        content: fileContent(file),
      })
    }
  }
  const tables = await listDataTables(db, scope)
  for (const table of tables) {
    entities.set(entityKey('table', table.id), {
      kind: 'table',
      logicalId: table.id,
      label: table.name,
      tableId: null,
      tableName: null,
      content: tableContent(table),
    })
    const rows = await listDataRows(db, scope, table.id)
    for (const row of rows) {
      entities.set(entityKey('row', row.id), {
        kind: 'row',
        logicalId: row.id,
        label: rowLabel(row, table),
        tableId: table.id,
        tableName: table.singularLabel,
        content: rowContent(row),
      })
    }
  }
  return entities
}
