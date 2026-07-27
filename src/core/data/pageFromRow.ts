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
 *
 * Ownership is mapped between DataRow user-id columns and Page optional fields:
 *   row.authorUserId        → page.ownerUserId
 *   row.createdByUserId     → page.createdByUserId
 *   row.updatedByUserId     → page.updatedByUserId
 */

import type { Page, PageNode, PageAccess, PageTemplateConfig } from '@core/page-tree'
import { parsePageTemplate } from '@core/page-tree'
import type { DataRow, DataRowCells } from '@core/data/schemas'

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

  // Access reconstruction (D14). Best-effort: a malformed cell is dropped,
  // which is semantically `public` (the page-tree tolerant parser treats a
  // missing access field as public). Only non-public restrictions survive.
  const access = readAccessFromCells(cells)

  return {
    id: row.id,
    slug: row.slug,
    title,
    nodes,
    rootNodeId,
    ...(template !== null ? { template } : {}),
    ...(access !== null ? { access } : {}),
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

/**
 * Read a page's `access` cell (D14). Mirrors {@link readTemplateFromCells}:
 * returns the access object only for a non-public restriction, `null`
 * otherwise (omitted on the Page → semantically public). Defensively coerces
 * `groups` to a string[] and treats an empty list as public (avoid lockout).
 */
function readAccessFromCells(cells: DataRowCells): PageAccess | null {
  const raw = cells.access
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.level !== 'groups') return null
  const groups = Array.isArray(r.groups) ? r.groups.filter((g): g is string => typeof g === 'string') : []
  if (groups.length === 0) return null
  return { level: 'groups', groups }
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

  // Only persist the access cell when the page is actually restricted — a
  // public page carries no access cell, so the snapshot stays lean and a
  // missing cell round-trips to public via readAccessFromCells.
  if (page.access && page.access.level === 'groups' && (page.access.groups ?? []).length > 0) {
    cells.access = { level: 'groups', groups: page.access.groups ?? [] }
  }

  return cells
}
