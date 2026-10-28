import { UNTITLED_ROW_TITLE, readStringCell } from './cells'
import { dataTableHasField } from './fields'
import type { DataRow, DataRowCells, DataTable } from './schemas'

function hasCell(cells: DataRowCells, fieldId: string): boolean {
  return Object.prototype.hasOwnProperty.call(cells, fieldId)
}

function uniqueCopySlug(sourceSlug: string, siblingRows: DataRow[]): string {
  const existingSlugs = new Set<string>()
  for (const row of siblingRows) {
    if (row.slug) existingSlugs.add(row.slug)
    const cellSlug = readStringCell(row.cells, 'slug')
    if (cellSlug) existingSlugs.add(cellSlug)
  }

  const baseSlug = sourceSlug ? `${sourceSlug}-copy` : 'copy'
  let slug = baseSlug
  let suffix = 2
  while (existingSlugs.has(slug)) {
    slug = `${baseSlug}-${suffix}`
    suffix += 1
  }
  return slug
}

export function buildDuplicateRowCells(
  table: Pick<DataTable, 'fields'>,
  row: DataRow,
  siblingRows: DataRow[],
): DataRowCells {
  const cells = structuredClone(row.cells) as DataRowCells

  if (dataTableHasField(table, 'title') || hasCell(row.cells, 'title')) {
    const title = readStringCell(row.cells, 'title')
    cells.title = `${title || UNTITLED_ROW_TITLE} (copy)`
  }

  if (dataTableHasField(table, 'slug')) {
    const sourceSlug = readStringCell(row.cells, 'slug') || row.slug
    cells.slug = uniqueCopySlug(sourceSlug, siblingRows)
  }

  return cells
}
