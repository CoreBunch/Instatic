/**
 * A page's structural settings live in cells of its row: `access` (who may
 * open the page) and `seo` (its `<head>` settings: canonical, robots,
 * structured data). Changing either is a structural decision
 * (`site.structure.edit`, enforced for the editor's own saves in
 * `pageDiff.ts`), but a page is also a row, and rows can be written through
 * the generic content paths: the Data and Content workspaces, version
 * restore, plugin content calls, the AI content tools, a bundle import.
 *
 * Those paths replace a row's cells wholesale, so a caller that left `access`
 * out would open a protected page to everyone, and one that sent its own
 * `seo` would rewrite how the page is indexed. Every such path runs its cells
 * through `keepPageStructuralCells`, which puts the stored values back unless
 * the caller is allowed to change them. A caller that may change them still
 * has `seo` normalised through `parsePageSeo`, so the cell only ever holds a
 * valid value.
 */
import { parsePageSeo } from '@core/page-tree'

/** The system table that holds pages. */
const PAGES_TABLE_ID = 'pages'

/** Page row cells only a `site.structure.edit` holder may change. */
const STRUCTURAL_PAGE_CELLS = ['access', 'seo'] as const

export function keepPageStructuralCells(
  stored: { tableId: string; cells: Record<string, unknown> },
  nextCells: Record<string, unknown>,
  mayChangeStructure = false,
): Record<string, unknown> {
  if (stored.tableId !== PAGES_TABLE_ID) return nextCells
  if (mayChangeStructure) return withNormalisedSeo(nextCells)
  const cells = { ...nextCells }
  for (const key of STRUCTURAL_PAGE_CELLS) {
    if (stored.cells[key] === undefined) delete cells[key]
    else cells[key] = stored.cells[key]
  }
  return cells
}

/**
 * The create-path counterpart of `keepPageStructuralCells`: a new page row
 * (rows API create, plugin `entries.create` / `createMany`, a bundle import of
 * a page id the site does not have) keeps head settings only when the caller
 * may change structure, normalised. Access on create is handled as before;
 * this covers `seo` only.
 */
export function newPageStructuralCells(
  tableId: string,
  cells: Record<string, unknown>,
  mayChangeStructure = false,
): Record<string, unknown> {
  if (tableId !== PAGES_TABLE_ID) return cells
  if (mayChangeStructure) return withNormalisedSeo(cells)
  const { seo: _dropped, ...rest } = cells
  return rest
}

function withNormalisedSeo(cells: Record<string, unknown>): Record<string, unknown> {
  if (cells.seo === undefined) return cells
  const { seo: raw, ...rest } = cells
  const seo = parsePageSeo(raw)
  return seo ? { ...rest, seo } : rest
}
