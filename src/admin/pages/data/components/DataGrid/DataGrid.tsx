/**
 * DataGrid — read-only spreadsheet-style grid for the Data admin page.
 *
 * Cells render as presentational chips / thumbnails / formatted values via
 * `CellDisplayRenderer`. Editing happens in the row inspector (opened when
 * the user clicks a row).
 *
 * This file is the container: it owns interaction state (search, status
 * filter, sort, selection, group collapse, column resize) and wires together
 * the presentational pieces — toolbar, header row, rows, skeleton, empty
 * state, bulk-action bar, and context menu. The filter → sort → group → count
 * pipeline lives in `dataGridRows.ts`; bulk-select state in `useDataGridSelection`.
 */
import {
  Fragment,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'
import type {
  DataRow,
  DataRowStatus,
  DataTable,
} from '@core/data/schemas'
import { DataGridBulkActionBar } from './DataGridBulkActionBar'
import { DataGridEmptyState } from './DataGridEmptyState'
import { DataGridGroupHeader } from './DataGridGroupHeader'
import { DataGridHeaderRow } from './DataGridHeaderRow'
import { DataGridRow } from './DataGridRow'
import { DataGridSkeletonRows } from './DataGridSkeletonRows'
import { DataGridToolbar } from './DataGridToolbar'
import { DataRowContextMenu } from './DataRowContextMenu'
import { usePrimaryColumnWidth } from './usePrimaryColumnWidth'
import { useDataGridSelection } from './useDataGridSelection'
import {
  computeStatusCounts,
  filterAndSortRows,
  getColumnWidth,
  getOrderedFields,
  getSubtitleFieldId,
  groupRowsByStatus,
  STATUS_VIEW_ORDER_DEFAULT,
  STATUS_VIEW_ORDER_PAGES,
  type SortState,
  type StatusFilter,
} from './dataGridRows'
import styles from './DataGrid.module.css'

interface DataGridProps {
  table: DataTable
  rows: DataRow[]
  /** Full tables list — for resolving relation target metadata. */
  tables: DataTable[]
  selectedRowId: string | null
  loading?: boolean
  error?: string | null
  readOnly?: boolean
  /** Click on a row — typically opens the inspector. */
  onSelectRow: (rowId: string | null) => void
  onAddRow: () => Promise<void> | void
  /** Delete a row by id. Omit to hide per-row + bulk delete. */
  onDeleteRow?: (rowId: string) => void
  /** Duplicate a row. Omit to hide the duplicate action. */
  onDuplicateRow?: (row: DataRow) => void | Promise<void>
  /** 'Edit in Content' — only meaningful for `kind='postType'` tables. */
  onEditInContent?: (row: DataRow) => void
  /** 'Open' — selects and opens the row inspector for `kind='data'` tables. */
  onOpenRow?: (rowId: string) => void
  /** Open the visual Site editor for page/component rows. */
  onOpenInSiteEditor?: (row: DataRow) => void
  /** Set a row's status. PostType only — enables bulk publish / unpublish. */
  onSetRowStatus?: (rowId: string, status: DataRowStatus) => Promise<DataRow>
  /** Called from the bulk-action bar's "Export" button. */
  onExportRows?: (rowIds: string[]) => void
}

interface RowContextMenuState {
  x: number
  y: number
  rowId: string
}

export function DataGrid({
  table,
  rows,
  tables,
  selectedRowId,
  loading = false,
  error = null,
  readOnly = false,
  onSelectRow,
  onAddRow,
  onDeleteRow,
  onDuplicateRow,
  onEditInContent,
  onOpenRow,
  onOpenInSiteEditor,
  onSetRowStatus,
  onExportRows,
}: DataGridProps): ReactElement {
  const isPostType = table.kind === 'postType'
  const isPageTable = table.kind === 'page'
  // Posts, Pages and Components all share the published/draft/archived
  // workflow — so they get the same chip-style filter row, status grouping,
  // and bulk publish/draft actions. Plain `data` tables stay flat.
  const hasPublishWorkflow = isPostType || isPageTable || table.kind === 'component'
  const statusViewOrder = isPageTable ? STATUS_VIEW_ORDER_PAGES : STATUS_VIEW_ORDER_DEFAULT

  // ── Primary column width (per-table, persisted to localStorage) ───────────
  const [primaryWidth, setPrimaryWidth] = usePrimaryColumnWidth(table.id)

  // ── Toolbar state ─────────────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  // The search input stays bound to `query` (instant feedback) while the
  // expensive filter + sort over potentially thousands of rows reads the
  // deferred value — typing stays responsive and the heavy recompute runs at
  // lower priority.
  const deferredQuery = useDeferredValue(query)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortState | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<DataRowStatus>>(
    () => new Set(),
  )
  const [rowContextMenu, setRowContextMenu] = useState<RowContextMenuState | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  // ── Field ordering ────────────────────────────────────────────────────────
  const subtitleFieldId = getSubtitleFieldId(table)
  const orderedFields = getOrderedFields(table, subtitleFieldId)

  // ── Filtered + sorted rows, grouping, counts ──────────────────────────────
  const visibleRows = filterAndSortRows({
    rows,
    table,
    hasPublishWorkflow,
    statusFilter,
    query: deferredQuery,
    sort,
  })
  const groups = groupRowsByStatus(visibleRows, hasPublishWorkflow, statusFilter)
  const statusCounts = computeStatusCounts(rows)

  // ── Selection ─────────────────────────────────────────────────────────────
  const selection = useDataGridSelection(visibleRows)

  function toggleGroupCollapsed(status: DataRowStatus): void {
    setCollapsedGroups((prev) => {
      const out = new Set(prev)
      if (out.has(status)) out.delete(status)
      else out.add(status)
      return out
    })
  }

  // ── Header sort click ─────────────────────────────────────────────────────
  function handleSort(fieldId: string): void {
    setSort((prev) => {
      if (prev == null || prev.fieldId !== fieldId) return { fieldId, dir: 'asc' }
      if (prev.dir === 'asc') return { fieldId, dir: 'desc' }
      return null
    })
  }

  function clearSort(): void {
    setSort(null)
  }

  // ── Bulk action handlers ──────────────────────────────────────────────────
  function handleBulkDelete(): void {
    if (onDeleteRow == null) return
    for (const id of selection.checkedIds) onDeleteRow(id)
    selection.clearSelection()
  }

  async function handleBulkSetStatus(status: DataRowStatus): Promise<void> {
    if (onSetRowStatus == null) return
    const ids = Array.from(selection.checkedIds)
    await Promise.all(ids.map((id) => onSetRowStatus(id, status)))
    selection.clearSelection()
  }

  // ── Per-row primary action ────────────────────────────────────────────────
  function getPrimaryAction(row: DataRow): (() => void) | undefined {
    if (isPostType && onEditInContent != null) return () => onEditInContent(row)
    if (!isPostType && onOpenRow != null) return () => onOpenRow(row.id)
    return undefined
  }

  useEffect(() => {
    const grid = gridRef.current
    if (grid === null) return
    const currentGrid = grid

    function handleNativeContextMenu(event: MouseEvent): void {
      if (!(event.target instanceof Element)) return
      const rowElement = event.target.closest<HTMLElement>('[data-data-grid-row-id]')
      if (rowElement === null || !currentGrid.contains(rowElement)) return
      const rowId = rowElement.dataset.dataGridRowId
      if (!rowId) return

      event.preventDefault()
      event.stopPropagation()
      onSelectRow(rowId)
      setRowContextMenu({ x: event.clientX, y: event.clientY, rowId })
    }

    currentGrid.addEventListener('contextmenu', handleNativeContextMenu, { capture: true })
    return () => currentGrid.removeEventListener('contextmenu', handleNativeContextMenu, { capture: true })
  }, [onSelectRow])

  // ── Primary column resize ─────────────────────────────────────────────────
  //
  // State-driven so all side effects (window listeners + document.body cursor)
  // live in a single useEffect with deterministic cleanup. The mousedown
  // handler captures the starting clientX + width into `resizing`; the effect
  // attaches the move/up listeners and the body-cursor lock while `resizing`
  // is non-null, and the cleanup tears all of it down when `resizing` is set
  // back to null (or the component unmounts mid-drag).
  //
  // React Compiler requires this shape — direct `document.body.style.cursor`
  // writes from a function declared in the component body would be flagged
  // as render-time side effects (Rules of React: components must be pure).
  const [resizing, setResizing] = useState<{ startX: number; startWidth: number } | null>(null)

  function handlePrimaryResizeStart(e: ReactMouseEvent): void {
    setResizing({ startX: e.clientX, startWidth: primaryWidth })
  }

  useEffect(() => {
    if (resizing == null) return
    const { startX, startWidth } = resizing

    function onMove(ev: MouseEvent): void {
      setPrimaryWidth(startWidth + (ev.clientX - startX))
    }
    function onUp(): void {
      setResizing(null)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    // Prevent accidental text selection during the drag.
    document.body.style.userSelect = 'none'

    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [resizing, setPrimaryWidth])

  // [ checkbox 36px ] [ ...fields ] [ trailing actions minmax(min-content, 1fr) ]
  const columnWidths = [
    '36px',
    ...orderedFields.map((f) =>
      getColumnWidth(f, f.id === table.primaryFieldId, primaryWidth),
    ),
    'minmax(min-content, 1fr)',
  ]
  const gridStyle = {
    '--data-grid-columns': columnWidths.join(' '),
  } as CSSProperties

  // Sticky-left offset for primary column = width of checkbox col (36px).
  const primaryStickyLeft: CSSProperties = { left: '36px' }
  const checkboxStickyLeft: CSSProperties = { left: '0' }

  // ── Toolbar / subtitle helpers ────────────────────────────────────────────
  const rowCount = visibleRows.length
  const isFiltered = query.trim().length > 0 || statusFilter !== 'all'

  // Active sort indicator (right of toolbarBottom).
  const sortField = sort != null ? table.fields.find((f) => f.id === sort.fieldId) : null
  const sortLabel = sortField?.label ?? null

  // Non-primary field count drives the skeleton column ladder.
  const skeletonFieldCount = orderedFields.filter((f) => f.id !== table.primaryFieldId).length

  // ── Render helpers ────────────────────────────────────────────────────────
  function renderRow(row: DataRow): ReactElement {
    return (
      <DataGridRow
        key={row.id}
        row={row}
        fields={orderedFields}
        primaryFieldId={table.primaryFieldId}
        subtitleFieldId={subtitleFieldId}
        table={table}
        tables={tables}
        rows={rows}
        selected={row.id === selectedRowId}
        checked={selection.checkedIds.has(row.id)}
        readOnly={readOnly}
        showStatusDot={hasPublishWorkflow}
        onSelect={() => onSelectRow(row.id)}
        onCheckedChange={(next) => selection.toggleRow(row.id, next)}
        onPrimaryAction={getPrimaryAction(row)}
        onDelete={onDeleteRow != null ? () => onDeleteRow(row.id) : undefined}
        primaryStickyLeft={primaryStickyLeft}
        checkboxStickyLeft={checkboxStickyLeft}
      />
    )
  }

  const contextMenuRow = rowContextMenu === null
    ? null
    : rows.find((row) => row.id === rowContextMenu.rowId) ?? null

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.gridWrapper}>
      <DataGridToolbar
        table={table}
        totalCount={rows.length}
        loading={loading}
        readOnly={readOnly}
        query={query}
        onQueryChange={setQuery}
        onAddRow={onAddRow}
        hasPublishWorkflow={hasPublishWorkflow}
        statusViewOrder={statusViewOrder}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        statusCounts={statusCounts}
        sort={sort}
        sortLabel={sortLabel}
        onClearSort={clearSort}
      />

      {/* ── Error state (outside the grid — full width) ─────────────────── */}
      {error != null && (
        <div role="alert" className={styles.errorState}>
          <p className={styles.errorText}>{error}</p>
          <p className={styles.errorHint}>Check your connection and try again.</p>
        </div>
      )}

      {/* ── Scrollable grid area ────────────────────────────────────────── */}
      {error == null && (
        <div className={styles.scrollContainer}>
          <div
            ref={gridRef}
            role="grid"
            className={styles.grid}
            style={gridStyle}
            aria-label={`${table.pluralLabel} data grid`}
            aria-rowcount={rowCount}
            aria-busy={loading}
          >
            <DataGridHeaderRow
              fields={orderedFields}
              primaryFieldId={table.primaryFieldId}
              sort={sort}
              headerChecked={selection.headerChecked}
              allChecked={selection.allChecked}
              onToggleAll={selection.toggleAll}
              onSort={handleSort}
              primaryStickyLeft={primaryStickyLeft}
              checkboxStickyLeft={checkboxStickyLeft}
              onPrimaryResizeStart={handlePrimaryResizeStart}
            />

            {loading && (
              <DataGridSkeletonRows
                fieldCount={skeletonFieldCount}
                primaryStickyLeft={primaryStickyLeft}
              />
            )}

            {!loading && rowCount === 0 && (
              <DataGridEmptyState
                table={table}
                filtered={isFiltered}
                readOnly={readOnly}
                onAddRow={onAddRow}
              />
            )}

            {/* ── Groups + rows ──────────────────────────────────────────── */}
            {!loading && groups.map((group) => {
              const collapsed = group.status != null && collapsedGroups.has(group.status)
              return (
                <Fragment key={group.key}>
                  <DataGridGroupHeader
                    group={group}
                    collapsed={collapsed}
                    onToggle={toggleGroupCollapsed}
                  />
                  {!collapsed && group.rows.map((row) => renderRow(row))}
                </Fragment>
              )
            })}
          </div>
        </div>
      )}

      <DataGridBulkActionBar
        selectedCount={selection.checkedIds.size}
        hasPublishWorkflow={hasPublishWorkflow}
        onClearSelection={selection.clearSelection}
        onSetStatus={onSetRowStatus != null ? (status) => { void handleBulkSetStatus(status) } : undefined}
        onExport={onExportRows != null ? () => onExportRows(Array.from(selection.checkedIds)) : undefined}
        onDelete={onDeleteRow != null ? handleBulkDelete : undefined}
      />

      {rowContextMenu !== null && contextMenuRow !== null && (
        <DataRowContextMenu
          x={rowContextMenu.x}
          y={rowContextMenu.y}
          row={contextMenuRow}
          table={table}
          onClose={() => setRowContextMenu(null)}
          onInspectRow={() => onSelectRow(contextMenuRow.id)}
          onOpenRow={onOpenRow}
          onDuplicateRow={onDuplicateRow}
          onEditInContent={onEditInContent}
          onOpenInSiteEditor={onOpenInSiteEditor}
          onSetRowStatus={onSetRowStatus}
          onExportRows={onExportRows}
          onDeleteRow={onDeleteRow}
        />
      )}
    </div>
  )
}
