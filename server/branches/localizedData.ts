import type { DbClient } from '../db/client'
import type { BranchScope } from './scope'
import { adapterFor, type EntityRef } from './entities'
import { getDraftSite } from '../repositories/site'
import { listDataRows, listDataTables } from '../repositories/data'
import { assertLocalizedDataWrite, readableLocalizedDataKeys } from '../repositories/data/localization'
import { findUserById } from '../repositories/users'
import { userHasCapability } from '../auth/authz'
import { validateMergedShell } from './entities/shell'
import { physicalId } from '@core/branches'
import { hasLocalizedDataFields, localizedDataReferences, LocalizedDataReferenceAccessError } from '@core/data/localizedCells'
import type { DataField, DataRowCells } from '@core/data/schemas'
import { LocalizationError } from '@core/localization'

export interface LocalizedBranchWrite {
  target: EntityRef
  content: unknown | null
}

/** Validate the resolved final state, rather than an intermediate table/row schema during a merge. */
export async function assertLocalizedBranchWritePlan(db: DbClient, scope: BranchScope, writes: readonly LocalizedBranchWrite[], actorUserId: string | null, readableScopes: readonly BranchScope[]): Promise<void> {
  const originalTables = await listDataTables(db, scope)
  const tables = new Map<string, { fields: readonly DataField[] }>(originalTables.map(table => [table.id, table]))
  const originalRows = new Map<string, { tableId: string; cells: DataRowCells }>()
  for (const table of originalTables) {
    for (const row of await listDataRows(db, scope, table.id)) originalRows.set(row.id, row)
  }
  const rows = new Map(originalRows)
  let shell = await getDraftSite(db, scope)
  // Files and settings form one final catalogue authority, regardless of adapter write order.
  for (const { target, content } of writes) {
    if (target.kind === 'table') {
      if (content === null) tables.delete(target.logicalId)
      else tables.set(target.logicalId, adapterFor('table').parse(content))
    } else if (target.kind === 'row') {
      if (content === null) rows.delete(target.logicalId)
      else rows.set(target.logicalId, adapterFor('row').parse(content))
    } else if (target.kind === 'site' && shell && content !== null) {
      const site = adapterFor('site').parse(content)
      shell = validateMergedShell(target.key, { ...shell, ...site.shell, name: site.name })
    } else if (target.kind === 'file' && shell) {
      const others = shell.files.filter(file => file.id !== target.logicalId)
      shell = { ...shell, files: content === null ? others : [...others, {
        ...adapterFor('file').parse(content), id: target.logicalId, createdAt: 0, updatedAt: 0,
      }] }
    }
  }
  const actor = actorUserId ? await findUserById(db, actorUserId) : null
  if (actorUserId && !actor) throw new LocalizationError('author', 'The content author could not be resolved')
  const allowedKeys = actor && !userHasCapability(actor, 'site.read') ? new Set<string>() : undefined
  if (actor && allowedKeys) {
    for (const readableScope of readableScopes) {
      for (const key of await readableLocalizedDataKeys(db, readableScope, actor)) allowedKeys.add(key)
    }
  }
  const originalFields = new Map(originalTables.map(table => [table.id, table.fields]))
  const candidates: Array<{ fields: readonly DataField[]; cells: DataRowCells; baseline: Map<string, string>; path: string }> = []
  for (const [rowId, row] of rows) {
    const table = tables.get(row.tableId)
    if (!table || !hasLocalizedDataFields(table.fields)) continue
    const path = `tables.${row.tableId}.cells`
    const before = originalRows.get(rowId)
    const baselineFields = before ? originalFields.get(before.tableId) ?? [] : []
    candidates.push({ fields: table.fields, cells: row.cells,
      baseline: localizedDataReferences(before?.cells ?? {}, baselineFields, path), path })
    const { rows: versions } = await db<{ cells_json: DataRowCells }>`select cells_json from data_row_versions where row_id = ${physicalId(scope.branchId, rowId)}`
    for (const version of versions) {
      candidates.push({ fields: table.fields, cells: version.cells_json,
        baseline: localizedDataReferences(version.cells_json, baselineFields, path), path })
    }
  }
  // Check every newly introduced reference before looking up any catalogue text.
  if (allowedKeys) {
    for (const candidate of candidates) {
      for (const [path, key] of localizedDataReferences(candidate.cells, candidate.fields, candidate.path)) {
        if (candidate.baseline.get(path) !== key && !allowedKeys.has(key)) throw new LocalizedDataReferenceAccessError(path)
      }
    }
  }
  for (const candidate of candidates) {
    await assertLocalizedDataWrite(db, scope, candidate.fields, candidate.cells, null, null, candidate.path, shell ?? undefined)
  }
}
