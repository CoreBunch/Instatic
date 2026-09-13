/**
 * Import preview endpoint.
 *
 *   POST /admin/api/cms/import/preview
 *
 * Accepts a `SiteBundle` body and returns a read-only diff (`BundlePreview`)
 * that describes what a subsequent import would do — without actually changing
 * any data. The operator uses this to review the bundle contents before
 * committing an import.
 *
 * For each table in the bundle the preview reports:
 *   - `inBundle`     — how many rows the bundle carries for this table
 *   - `willReplace`  — bundle rows whose id already exists locally
 *   - `willAdd`      — bundle rows whose id does not exist locally
 *   - `currentLocal` — how many rows the local table currently has
 *
 * Requires `data.export` capability (paired with the actual export
 * endpoint — preview is the read-only dry-run that precedes import).
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { listDataRows } from '../../repositories/data/rows'
import { listDataTables } from '../../repositories/data/tables'
import { jsonResponse, readValidatedBody } from '../../http'
import { parseValue } from '@core/utils/typeboxHelpers'
import {
  SiteBundleSchema,
  BundlePreviewSchema,
  type BundlePreview,
  type BundleRowConflict,
} from '@core/data/bundleSchema'
import type { DataRow, DataTable } from '@core/data/schemas'
import { CMS_API_PREFIX } from './shared'
import type { BranchScope } from '../../branches/scope'

export async function handleImportPreviewRoute(
  req: Request,
  db: DbClient,
  scope: BranchScope,
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/import/preview`) return null
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, { status: 405 })

  const user = await requireCapability(req, db, 'data.export')
  if (user instanceof Response) return user

  const bundle = await readValidatedBody(req, SiteBundleSchema)
  if (!bundle) {
    return jsonResponse({ error: 'Invalid bundle: body does not conform to SiteBundleSchema' }, { status: 400 })
  }

  // Fetch current local tables to know which ones exist
  const localTables = await listDataTables(db, scope)
  const localTableIds = new Set(localTables.map((t) => t.id))

  const rowConflicts: BundleRowConflict[] = []

  // For each bundle table, compute the diff against local row ids and active slugs.
  const tableEntries = await Promise.all(
    bundle.tables.map(async (table) => {
      // Rows in the bundle for this table
      const bundleRowsForTable = bundle.rows
        .filter((r) => r.tableId === table.id)
      const bundleRowIdsForTable = bundleRowsForTable.map((r) => r.id)

      // Local rows for this table (0 if the table doesn't exist locally yet)
      let localRows: DataRow[]
      if (localTableIds.has(table.id)) {
        localRows = await listDataRows(db, scope, table.id)
      } else {
        localRows = []
      }
      const localRowIds = new Set(localRows.map((r) => r.id))
      rowConflicts.push(...findRowSlugConflicts(table, bundleRowsForTable, localRows))

      const willReplace = bundleRowIdsForTable.filter((id) => localRowIds.has(id)).length
      const willAdd = bundleRowIdsForTable.filter((id) => !localRowIds.has(id)).length

      return {
        id: table.id,
        name: table.name,
        kind: table.kind,
        inBundle: bundleRowIdsForTable.length,
        willReplace,
        willAdd,
        currentLocal: localRowIds.size,
      }
    }),
  )

  const preview: BundlePreview = {
    meta: {
      exportedAt: bundle.exportedAt,
      sourceSiteName: bundle.sourceSiteName ?? null,
      schemaVersion: bundle.schemaVersion,
    },
    tables: tableEntries,
    rowConflicts,
    totals: {
      rows: bundle.rows.length,
      mediaFiles: bundle.media?.length ?? 0,
      mediaEmbedded: (bundle.media?.length ?? 0) > 0,
      mediaFolders: bundle.mediaFolders?.length ?? 0,
      redirects: bundle.redirects?.length ?? 0,
    },
  }

  // Paranoia: validate the shape before returning
  parseValue(BundlePreviewSchema, preview)

  return jsonResponse(preview)
}

function findRowSlugConflicts(
  table: DataTable,
  bundleRows: DataRow[],
  localRows: DataRow[],
): BundleRowConflict[] {
  const localRowsBySlug = new Map(
    localRows
      .filter((row) => row.slug)
      .map((row) => [row.slug, row]),
  )
  const reservedSlugs = new Set([
    ...localRowsBySlug.keys(),
    ...bundleRows.map((row) => row.slug).filter((slug) => slug.length > 0),
  ])
  const conflicts: BundleRowConflict[] = []

  for (const row of bundleRows) {
    const localRow = row.slug ? localRowsBySlug.get(row.slug) : undefined
    if (!localRow || localRow.id === row.id) continue
    conflicts.push({
      tableId: table.id,
      tableName: table.name,
      rowId: row.id,
      rowTitle: rowTitle(row, table.primaryFieldId),
      slug: row.slug,
      existingRowId: localRow.id,
      suggestedSlug: nextAvailableSlug(row.slug, reservedSlugs),
    })
  }

  return conflicts
}

function rowTitle(row: DataRow, primaryFieldId: string): string {
  const primary = row.cells[primaryFieldId]
  if (typeof primary === 'string' && primary.trim()) return primary
  return row.slug || row.id
}

function nextAvailableSlug(slug: string, reservedSlugs: Set<string>): string {
  let index = 2
  let candidate = `${slug}-${index}`
  while (reservedSlugs.has(candidate)) {
    index++
    candidate = `${slug}-${index}`
  }
  reservedSlugs.add(candidate)
  return candidate
}
