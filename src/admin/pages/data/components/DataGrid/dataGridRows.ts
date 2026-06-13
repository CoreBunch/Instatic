/**
 * dataGridRows — pure helpers for the DataGrid container.
 *
 * Everything here is side-effect free: column sizing, the cell comparator,
 * field ordering, and the filter → sort → group → count pipeline that turns
 * the raw `rows` array into the shape the grid renders. Keeping it out of the
 * component body keeps `DataGrid.tsx` focused on wiring + interaction state.
 */
import type {
  DataField,
  DataRow,
  DataRowStatus,
  DataTable,
} from '@core/data/schemas'

// ---------------------------------------------------------------------------
// View-filter model
// ---------------------------------------------------------------------------

/**
 * The view-chip filter. For tables with a publish workflow this collapses
 * row visibility down to one chip.
 *
 *   - 'all'         — every row, grouped by status when no specific chip is active
 *   - 'pages'       — page rows where `templateEnabled !== true` (page table only)
 *   - 'templates'   — page rows where `templateEnabled === true` (page table only)
 *   - 'published'   — `status = 'published'`
 *   - 'draft'       — `status = 'draft'`
 *   - 'unpublished' — `status = 'unpublished'` (rendered as "Archived")
 */
export type StatusFilter = 'all' | 'pages' | 'templates' | DataRowStatus

export interface SortState {
  fieldId: string
  dir: 'asc' | 'desc'
}

export interface RowGroup {
  key: string
  label: string | null
  status: DataRowStatus | null
  rows: DataRow[]
}

export interface StatusViewChip {
  key: StatusFilter
  label: string
}

export type StatusCounts = Record<StatusFilter, number>

export const STATUS_VIEW_ORDER_DEFAULT: StatusViewChip[] = [
  { key: 'all',         label: 'All' },
  { key: 'published',   label: 'Published' },
  { key: 'scheduled',   label: 'Scheduled' },
  { key: 'draft',       label: 'Drafts' },
  { key: 'unpublished', label: 'Archived' },
]

/** Pages get extra chips for the template-flag filter, sequenced between
 *  the base 'All' chip and the status chips so the eye reads them as a
 *  scope refinement before drilling into status. */
export const STATUS_VIEW_ORDER_PAGES: StatusViewChip[] = [
  { key: 'all',         label: 'All' },
  { key: 'pages',       label: 'Pages' },
  { key: 'templates',   label: 'Templates' },
  { key: 'published',   label: 'Published' },
  { key: 'scheduled',   label: 'Scheduled' },
  { key: 'draft',       label: 'Drafts' },
  { key: 'unpublished', label: 'Archived' },
]

// ---------------------------------------------------------------------------
// Column sizing
// ---------------------------------------------------------------------------

export function getColumnWidth(
  field: DataField,
  isPrimary: boolean,
  primaryWidth: number,
): string {
  if (isPrimary) return `${primaryWidth}px`
  switch (field.type) {
    case 'number':
    case 'boolean':
    case 'date':
    case 'dateTime':
      return '140px'
    case 'media':
    case 'relation':
      return '220px'
    case 'select':
      return '160px'
    case 'multiSelect':
      return '220px'
    case 'longText':
    case 'richText':
      return '260px'
    default:
      return '200px'
  }
}

// ---------------------------------------------------------------------------
// Field ordering
// ---------------------------------------------------------------------------

/**
 * The subtitle field (slug, when present and distinct from the primary) is
 * collapsed into the primary cell as a subtitle rather than shown as its own
 * column. Returns `null` when there's no separate slug field to collapse.
 */
export function getSubtitleFieldId(table: DataTable): string | null {
  if (table.primaryFieldId === 'slug') return null
  return table.fields.some((f) => f.id === 'slug') ? 'slug' : null
}

/** Primary field first, then the rest minus the collapsed subtitle field. */
export function getOrderedFields(
  table: DataTable,
  subtitleFieldId: string | null,
): DataField[] {
  const primary = table.fields.find((f) => f.id === table.primaryFieldId)
  const rest = table.fields.filter(
    (f) => f.id !== table.primaryFieldId && f.id !== subtitleFieldId,
  )
  return primary == null ? rest : [primary, ...rest]
}

// ---------------------------------------------------------------------------
// Filter + sort
// ---------------------------------------------------------------------------

interface FilterRowsParams {
  rows: DataRow[]
  table: DataTable
  hasPublishWorkflow: boolean
  statusFilter: StatusFilter
  /** Already lower/trim-normalized by the caller is fine — we normalize too. */
  query: string
  sort: SortState | null
}

export function filterAndSortRows({
  rows,
  table,
  hasPublishWorkflow,
  statusFilter,
  query,
  sort,
}: FilterRowsParams): DataRow[] {
  let r = rows

  if (hasPublishWorkflow && statusFilter !== 'all') {
    // The 'pages' / 'templates' chips only filter the template flag —
    // they cross-cut status, so within each scope we still show drafts
    // alongside published rows (and they get grouped by status below).
    if (statusFilter === 'pages') {
      r = r.filter((row) => row.cells.templateEnabled !== true)
    } else if (statusFilter === 'templates') {
      r = r.filter((row) => row.cells.templateEnabled === true)
    } else {
      // 'draft' | 'published' | 'unpublished' | 'scheduled' — filter on row.status
      r = r.filter((row) => row.status === statusFilter)
    }
  }

  const q = query.trim().toLowerCase()
  if (q.length > 0) {
    r = r.filter((row) => {
      for (const field of table.fields) {
        const v = row.cells[field.id]
        if (typeof v === 'string' && v.toLowerCase().includes(q)) return true
      }
      return false
    })
  }

  if (sort != null) {
    r = [...r].sort((a, b) => {
      const av = a.cells[sort.fieldId]
      const bv = b.cells[sort.fieldId]
      const cmp = compareCellValues(av, bv)
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }

  return r
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Group rows by status for publish-workflow kinds when the active scope is
 * 'all' / 'pages' / 'templates' (those cross-cut status, so we still want the
 * Published / Drafts / Archived section headers). Specific status chips
 * flatten the list, since by definition all rows then share one status.
 */
export function groupRowsByStatus(
  visibleRows: DataRow[],
  hasPublishWorkflow: boolean,
  statusFilter: StatusFilter,
): RowGroup[] {
  const groupable =
    hasPublishWorkflow &&
    (statusFilter === 'all' || statusFilter === 'pages' || statusFilter === 'templates')
  if (!groupable) {
    return [{ key: 'all', label: null, status: null, rows: visibleRows }]
  }
  const buckets: Record<DataRowStatus, DataRow[]> = {
    published: [],
    draft: [],
    unpublished: [],
    scheduled: [],
  }
  for (const row of visibleRows) buckets[row.status].push(row)
  const out: RowGroup[] = []
  if (buckets.published.length > 0)
    out.push({ key: 'published', label: 'Published', status: 'published', rows: buckets.published })
  if (buckets.scheduled.length > 0)
    out.push({ key: 'scheduled', label: 'Scheduled', status: 'scheduled', rows: buckets.scheduled })
  if (buckets.draft.length > 0)
    out.push({ key: 'draft', label: 'Drafts', status: 'draft', rows: buckets.draft })
  if (buckets.unpublished.length > 0)
    out.push({ key: 'unpublished', label: 'Archived', status: 'unpublished', rows: buckets.unpublished })
  return out
}

// ---------------------------------------------------------------------------
// Filter chip counts
// ---------------------------------------------------------------------------

/**
 * For pages, the 'Pages' and 'Templates' chips count by template-flag
 * (cross-cut by status). For posts/components those chips don't appear, so
 * their counts default to 0 and are never read.
 */
export function computeStatusCounts(rows: DataRow[]): StatusCounts {
  const counts: StatusCounts = {
    all: rows.length,
    published: 0,
    draft: 0,
    unpublished: 0,
    scheduled: 0,
    pages: 0,
    templates: 0,
  }
  for (const r of rows) {
    counts[r.status] += 1
    if (r.cells.templateEnabled === true) counts.templates += 1
    else counts.pages += 1
  }
  return counts
}

// ---------------------------------------------------------------------------
// Cell comparator — numeric > date > string fallback.
// ---------------------------------------------------------------------------

function compareCellValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  const sa = String(a)
  const sb = String(b)
  // Use numeric collation so '10' sorts after '2', and respect locale for dates.
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' })
}
