/**
 * Bidirectional adapter between `Page` (in-memory type) and `DataRow` / `DataRowCells`
 * (the unified storage layer).
 *
 * Pages are stored in `data_rows` where `table_id = 'pages'`. The `pages`
 * system table fields map to Page fields as follows:
 *
 *   cells.title              → page.title
 *   cells.slug (= row.slug)  → page.slug (denormalized on data_rows.slug)
 *   cells.body               → { nodes, rootNodeId } (pageTree field)
 *   cells.templateEnabled    → page.template.enabled
 *   cells.templateTarget     → page.template.target (stored as JSON object)
 *   cells.templatePriority   → page.template.priority
 *   cells.seo                → page.seo (structured SeoMetadata)
 *
 * Ownership is mapped between DataRow user-id columns and Page optional fields:
 *   row.authorUserId        → page.ownerUserId
 *   row.createdByUserId     → page.createdByUserId
 *   row.updatedByUserId     → page.updatedByUserId
 */

import type { Page, PageNode, PageTemplateConfig } from '@core/page-tree'
import { parsePageTemplate } from '@core/page-tree'
import { parseSeoMetadata } from '@core/seo'
import type { DataRow, DataRowCells } from './schemas'

// ---------------------------------------------------------------------------
// DataRow → Page
// ---------------------------------------------------------------------------

/**
 * Reconstruct a `Page` from a `DataRow` (table_id = 'pages').
 *
 * The conversion is best-effort: missing or malformed cells fall back to safe
 * defaults (empty title, empty nodes, etc.) so a corrupt row doesn't prevent
 * loading the rest of the site. Structural validation (slug syntax, rootNodeId
 * presence) is enforced by `validatePages` in `@core/persistence/validate`.
 */
export function pageFromRow(row: DataRow): Page {
  const cells = row.cells

  // body field: NodeTree<PageNode>  { nodes: {...}, rootNodeId: '...' }
  let nodes: Record<string, PageNode> = {}
  let rootNodeId = ''
  const body = cells.body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const b = body as Record<string, unknown>
    if (b.nodes && typeof b.nodes === 'object' && !Array.isArray(b.nodes)) {
      nodes = b.nodes as Record<string, PageNode>
    }
    if (typeof b.rootNodeId === 'string') {
      rootNodeId = b.rootNodeId
    }
  }

  const title = typeof cells.title === 'string' ? cells.title : ''

  // Template reconstruction
  const template = readTemplateFromCells(cells)
  const seo = parseSeoMetadata(cells.seo)

  return {
    id: row.id,
    slug: row.slug,
    title,
    nodes,
    rootNodeId,
    ...(template !== null ? { template } : {}),
    ...(seo !== undefined ? { seo } : {}),
    ownerUserId: row.authorUserId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
  }
}

function readTemplateFromCells(cells: DataRowCells): PageTemplateConfig | null {
  if (cells.templateEnabled !== true) return null
  return parsePageTemplate({
    enabled: true,
    target: cells.templateTarget,
    priority: cells.templatePriority,
  })
}

// ---------------------------------------------------------------------------
// Page → DataRowCells
// ---------------------------------------------------------------------------

/**
 * Convert a `Page` to the `DataRowCells` shape for storage in `data_rows`.
 *
 * The `slug` field is returned in cells AND should also be passed as the
 * `slug` parameter to `createDataRow` / `saveDataRowDraft` (the denormalized
 * column on `data_rows`).
 */
export function pageToCells(page: Page): DataRowCells {
  const cells: DataRowCells = {
    title: page.title,
    slug: page.slug,
    body: {
      nodes: page.nodes,
      rootNodeId: page.rootNodeId,
    },
  }

  if (page.template) {
    cells.templateEnabled = true
    cells.templateTarget = page.template.target
    cells.templatePriority = page.template.priority
  }

  if (page.seo) {
    cells.seo = page.seo
  }

  return cells
}
