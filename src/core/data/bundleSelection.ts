import { selectBundlePublication } from './bundlePublication'
import { parseValue } from '@core/utils/typeboxHelpers'
import {
  SiteBundleSchema,
  type BundleImportSelection,
  type SiteBundle,
  type TableSelection,
} from './bundleSchema'

interface BundleSelectionSource {
  site?: unknown
  tables: SiteBundle['tables']
  rows: SiteBundle['rows']
  media?: Array<{ id: string }>
  mediaFolders?: readonly unknown[]
  redirects?: SiteBundle['redirects']
}

export function makeFullBundleImportSelection(bundle: BundleSelectionSource): BundleImportSelection {
  return {
    includeSite: bundle.site !== undefined,
    tables: bundle.tables.map((table) => ({ tableId: table.id })),
    includeMedia: (bundle.media?.length ?? 0) > 0,
    includeMediaFolders: (bundle.mediaFolders?.length ?? 0) > 0,
    includeRedirects: (bundle.redirects?.length ?? 0) > 0,
  }
}

export function isFullBundleImportSelection(
  bundle: BundleSelectionSource,
  selection: BundleImportSelection,
): boolean {
  const full = makeFullBundleImportSelection(bundle)
  return (
    selection.includeSite === full.includeSite &&
    selection.includeMedia === full.includeMedia &&
    selection.mediaIds === undefined &&
    selection.includeMediaFolders === full.includeMediaFolders &&
    selection.includeRedirects === full.includeRedirects &&
    selection.rowSlugOverrides === undefined &&
    selection.tables.length === full.tables.length &&
    selection.tables.every((entry) => entry.rowIds === undefined && full.tables.some((table) => table.tableId === entry.tableId))
  )
}

export function filterSiteBundleForImportSelection(
  bundle: SiteBundle,
  selection: BundleImportSelection,
): SiteBundle {
  const tablesById = new Map(selection.tables.map((entry) => [entry.tableId, entry]))
  const slugOverrides = rowSlugOverrideMap(selection)
  const tables = bundle.tables.filter((table) => tablesById.has(table.id))
  const rows = bundle.rows
    .filter((row) => rowSelected(row, tablesById.get(row.tableId)))
    .map((row) => applyRowSlugOverride(row, slugOverrides.get(rowOverrideKey(row.tableId, row.id))))
  const selectedRowIds = new Set(rows.map((row) => row.id))
  const media = filterMedia(bundle.media, selection)
  const redirects = selection.includeRedirects && bundle.redirects
    ? bundle.redirects.filter((redirect) => selectedRowIds.has(redirect.targetRowId))
    : undefined

  return parseValue(SiteBundleSchema, {
    schemaVersion: bundle.schemaVersion,
    exportedAt: bundle.exportedAt,
    ...(bundle.sourceSiteName !== undefined ? { sourceSiteName: bundle.sourceSiteName } : {}),
    ...(selection.includeSite && bundle.site ? { site: bundle.site } : {}),
    tables,
    rows,
    ...(bundle.publication ? { publication: selectBundlePublication(bundle.publication, selectedRowIds) } : {}),
    ...(media ? { media } : {}),
    ...(selection.includeMediaFolders && bundle.mediaFolders ? { mediaFolders: bundle.mediaFolders } : {}),
    ...(redirects ? { redirects } : {}),
  })
}

function rowSlugOverrideMap(selection: BundleImportSelection): Map<string, string> {
  return new Map((selection.rowSlugOverrides ?? []).map((override) => [
    rowOverrideKey(override.tableId, override.rowId),
    override.slug,
  ]))
}

function rowOverrideKey(tableId: string, rowId: string): string {
  return `${tableId}:${rowId}`
}

function applyRowSlugOverride(
  row: SiteBundle['rows'][number],
  slug: string | undefined,
): SiteBundle['rows'][number] {
  if (!slug) return row
  return {
    ...row,
    slug,
    cells: typeof row.cells.slug === 'string'
      ? { ...row.cells, slug }
      : row.cells,
  }
}

function rowSelected(
  row: SiteBundle['rows'][number],
  tableSelection: TableSelection | undefined,
): boolean {
  if (!tableSelection) return false
  if (tableSelection.rowIds === undefined) return true
  return tableSelection.rowIds.includes(row.id)
}

function filterMedia(
  media: SiteBundle['media'] | undefined,
  selection: BundleImportSelection,
): SiteBundle['media'] | undefined {
  if (!selection.includeMedia || !media) return undefined
  if (selection.mediaIds === undefined) return media
  const selectedIds = new Set(selection.mediaIds)
  return media.filter((asset) => selectedIds.has(asset.id))
}
