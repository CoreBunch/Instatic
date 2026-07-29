/**
 * DataSidebar — left panel listing all data tables for the Data workspace.
 *
 * Renders the table list, loading/error states, and a "New table" CTA.
 * Uses the canonical Panel primitive for the inner panel slot — consistent
 * with the site editor's docked panels. The outer <aside> (rail + resize
 * handle) follows the LeftSidebar layout pattern.
 *
 * Export and Import buttons delegate to the parent via `onOpenExport` /
 * `onOpenImport` callbacks. Export stays Data-local; import opens the
 * canonical Site Import modal so CMS bundles and static-site imports share one
 * front door.
 */
import { useEffect, useEffectEvent, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Skeleton } from '@ui/components/Skeleton'
import { TagPill } from '@ui/components/TagPill'
import { railAccent, railTintVar } from '@ui/railAccent'
import type { PillAccent } from '@ui/pillAccent'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import { Panel } from '@admin/shared/Panel'
import { SidebarResizeHandle } from '@admin/shared/SidebarResizeHandle'
import leftSidebarStyles from '@site/sidebars/LeftSidebar/LeftSidebar.module.css'
import panelRailStyles from '@site/sidebars/PanelRail/PanelRail.module.css'
import type { DataTableListItem } from '@core/data/schemas'
import { DataTableContextMenu } from './DataTableContextMenu'
import styles from './DataSidebar.module.css'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DataSidebarProps {
  // TODO: each table now carries `rowCount` — consider rendering a count chip
  // next to the kind badge once the sidebar layout has a natural slot for it.
  tables: DataTableListItem[]
  loading: boolean
  error: string | null
  selectedTableId: string | null
  onSelectTable: (tableId: string) => void
  onOpenTableSettings: (tableId: string) => void
  onDeleteTable: (table: DataTableListItem) => void
  onCreateTable: () => void
  /** Opens the ExportDialog in the parent. */
  onOpenExport: () => void
  /** Opens the canonical Site Import modal in the parent. */
  onOpenImport: () => void
  canCreateTable: boolean
  canManage: boolean
  canExport: boolean
  canImport: boolean
}

interface TableContextMenuState {
  x: number
  y: number
  tableId: string
}

const TABLE_KIND_ACCENT: Record<DataTableListItem['kind'], PillAccent> = {
  page: 'a',
  postType: 'b',
  component: 'c',
  data: 'd',
  layout: 'l',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DataSidebar({
  tables,
  loading,
  error,
  selectedTableId,
  onSelectTable,
  onOpenTableSettings,
  onDeleteTable,
  onCreateTable,
  onOpenExport,
  onOpenImport,
  canCreateTable,
  canManage,
  canExport,
  canImport,
}: DataSidebarProps) {
  const sidebarRef = useRef<HTMLElement | null>(null)
  const tableListRef = useRef<HTMLDivElement | null>(null)
  const [contextMenu, setContextMenu] = useState<TableContextMenuState | null>(null)
  const leftSidebarWidth = useWorkspaceLayout((s) => s.leftSidebarWidth)
  const setLeftSidebarWidth = useWorkspaceLayout((s) => s.setLeftSidebarWidth)
  const dataSidebarCollapsed = useWorkspaceLayout((s) => s.dataSidebarCollapsed)
  const setDataSidebarCollapsed = useWorkspaceLayout((s) => s.setDataSidebarCollapsed)

  // When collapsed, only the outer allocation collapses. The panel body keeps
  // the saved layout width and is clipped by the sidebar shell, so text does
  // not reflow during open/close motion.
  const panelWidth = dataSidebarCollapsed ? 0 : leftSidebarWidth

  const style = {
    '--left-sidebar-panel-width': `${panelWidth}px`,
    '--left-sidebar-panel-layout-width': `${leftSidebarWidth}px`,
  } as CSSProperties
  const tablesRailAccent = railAccent('data:tables:Data tables')
  const tablesRailButtonStyle = {
    '--rail-icon-tint': railTintVar(tablesRailAccent),
  } as CSSProperties
  const contextMenuTable = contextMenu === null
    ? null
    : tables.find((table) => table.id === contextMenu.tableId) ?? null

  function openTableContextMenuAt(table: DataTableListItem, x: number, y: number): void {
    onSelectTable(table.id)
    setContextMenu({ x, y, tableId: table.id })
  }

  // Built-in system tables (posts/pages/components/layouts) are grouped apart
  // from user-created custom tables. `listDataTablesWithCounts` already sorts
  // system tables first, so partitioning preserves order within each group.
  const systemTables = tables.filter((table) => table.system)
  const customTables = tables.filter((table) => !table.system)

  function renderTableButton(table: DataTableListItem) {
    const selected = table.id === selectedTableId
    const kindLabel = table.kind === 'postType' ? 'post-type'
      : table.kind === 'page' ? 'page'
      : table.kind === 'component' ? 'component'
      : 'data'
    return (
      <Button
        key={table.id}
        variant="ghost"
        size="sm"
        fullWidth
        align="start"
        pressed={selected}
        role="option"
        aria-selected={selected}
        data-data-table-id={table.id}
        onClick={() => onSelectTable(table.id)}
        onContextMenuCapture={(event) => openTableContextMenu(table, event)}
        className={styles.tableButton}
      >
        <DatabaseSolidIcon size={13} aria-hidden="true" />
        <span className={styles.tableLabel}>{table.pluralLabel}</span>
        <TagPill
          label={kindLabel}
          accent={TABLE_KIND_ACCENT[table.kind]}
          size="xs"
          className={styles.tableKindBadge}
        />
      </Button>
    )
  }

  function openTableContextMenu(table: DataTableListItem, event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault()
    event.stopPropagation()
    openTableContextMenuAt(table, event.clientX, event.clientY)
  }

  const handleTableContextMenu = useEffectEvent((
    event: globalThis.MouseEvent,
    currentTableList: HTMLDivElement,
  ): void => {
    if (!(event.target instanceof Element)) return
    const tableElement = event.target.closest<HTMLElement>('[data-data-table-id]')
    if (tableElement === null || !currentTableList.contains(tableElement)) return
    const tableId = tableElement.dataset.dataTableId
    const table = tables.find((candidate) => candidate.id === tableId)
    if (table === undefined) return

    event.preventDefault()
    event.stopPropagation()
    onSelectTable(table.id)
    setContextMenu({ x: event.clientX, y: event.clientY, tableId: table.id })
  })

  useEffect(() => {
    const tableList = tableListRef.current
    if (tableList === null) return
    const currentTableList = tableList

    function handleNativeContextMenu(event: globalThis.MouseEvent): void {
      handleTableContextMenu(event, currentTableList)
    }

    currentTableList.addEventListener('contextmenu', handleNativeContextMenu, { capture: true })
    return () => currentTableList.removeEventListener('contextmenu', handleNativeContextMenu, { capture: true })
  }, [])

  return (
    <aside
      ref={sidebarRef}
      className={leftSidebarStyles.sidebar}
      data-testid="data-left-sidebar"
      data-expanded={dataSidebarCollapsed ? 'false' : 'true'}
      style={style}
    >
      {/* Rail — single icon representing the data panel */}
      <nav
        aria-label="Data panel dock"
        className={panelRailStyles.rail}
        data-testid="data-panel-rail"
      >
        <div className={panelRailStyles.itemGroup}>
          <Button
            variant="ghost"
            size="md"
            iconOnly
            pressed={!dataSidebarCollapsed}
            aria-label="Data tables panel"
            tooltip="Data tables panel"
            data-testid="data-panel-rail-tables"
            data-icon="database"
            data-accent={tablesRailAccent}
            style={tablesRailButtonStyle}
            onClick={() => setDataSidebarCollapsed(dataSidebarCollapsed ? false : true)}
            className={panelRailStyles.railButton}
          >
            <span className={panelRailStyles.activeIndicator} aria-hidden="true" />
            <DatabaseSolidIcon size={16} className={panelRailStyles.railIcon} />
          </Button>
        </div>
      </nav>

      {/* Panel slot */}
      <div
        className={leftSidebarStyles.panelSlot}
        data-testid="data-left-sidebar-panel-slot"
        inert={dataSidebarCollapsed ? true : undefined}
      >
        <div className={leftSidebarStyles.panelMount}>
          <Panel
            panelId="data-tables"
            title="Data tables"
            body="bare"
            onClose={() => setDataSidebarCollapsed(true)}
            headerActions={
              <>
                {canExport && (
                  <Button
                    variant="ghost"
                    size="xs"
                    iconOnly
                    aria-label="Export site"
                    tooltip="Export site"
                    onClick={onOpenExport}
                  >
                    <ArrowDownIcon size={13} aria-hidden="true" />
                  </Button>
                )}
                {canImport && (
                  <Button
                    variant="ghost"
                    size="xs"
                    iconOnly
                    aria-label="Import site"
                    tooltip="Import site"
                    onClick={onOpenImport}
                  >
                    <UploadIcon size={13} aria-hidden="true" />
                  </Button>
                )}
              </>
            }
          >
            <div
              ref={tableListRef}
              className={styles.tableList}
              role="listbox"
              aria-label="Data tables"
              aria-busy={loading || undefined}
            >
              {loading && Array.from({ length: 4 }, (_, i) => (
                // Skeleton row mirrors the real `.tableButton` chrome
                // (padding, gap, height, column ladder) via a plain
                // div — using a disabled `<Button>` would inherit its
                // `opacity: 0.38` and dim the shimmer so the row
                // reads as "muted disabled state" rather than a
                // proper loading skeleton.
                <div
                  key={`skeleton-${i}`}
                  className={styles.tableSkeletonRow}
                  aria-hidden="true"
                >
                  <Skeleton width={13} height={13} radius={3} />
                  <span className={styles.tableLabel}>
                    <Skeleton width={`${60 + (i % 3) * 14}%`} height={12} />
                  </span>
                  <Skeleton width={48} height={14} radius={999} />
                </div>
              ))}

              {!loading && error && (
                <p role="alert" className={styles.errorText}>
                  {error}
                </p>
              )}

              {/* System tables (built-in) first, then the user's custom tables.
                  The System group only renders when the user can see system
                  tables; the Custom group always renders so its "New table"
                  action has a home even with zero custom tables. */}
              {!loading && !error && systemTables.length > 0 && (
                <>
                  <div className={styles.sectionHeader}>
                    <h3 className={styles.sectionTitle}>System</h3>
                    <span className={styles.sectionCount}>{systemTables.length}</span>
                  </div>
                  {systemTables.map(renderTableButton)}
                </>
              )}

              {!loading && !error && (
                <>
                  <div className={styles.sectionHeader}>
                    <h3 className={styles.sectionTitle}>Custom tables</h3>
                    <span className={styles.sectionCount}>{customTables.length}</span>
                    {canCreateTable && (
                      <span className={styles.headerActions}>
                        <Button
                          variant="ghost"
                          size="xs"
                          iconOnly
                          aria-label="New table"
                          tooltip="New table"
                          onClick={onCreateTable}
                        >
                          <PlusIcon size={13} aria-hidden="true" />
                        </Button>
                      </span>
                    )}
                  </div>
                  {customTables.length > 0
                    ? customTables.map(renderTableButton)
                    : <p className={styles.emptyText}>None yet</p>}
                </>
              )}
            </div>
          </Panel>

          {contextMenu !== null && contextMenuTable !== null && (
            <DataTableContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              table={contextMenuTable}
              selected={contextMenuTable.id === selectedTableId}
              canManage={canManage}
              onClose={() => setContextMenu(null)}
              onSelectTable={onSelectTable}
              onOpenTableSettings={onOpenTableSettings}
              onDeleteTable={onDeleteTable}
            />
          )}
        </div>
      </div>

      {!dataSidebarCollapsed && (
        <SidebarResizeHandle
          side="left"
          width={leftSidebarWidth}
          targetRef={sidebarRef}
          cssVariable="--left-sidebar-panel-width"
          layoutCssVariable="--left-sidebar-panel-layout-width"
          ariaLabel="Resize data sidebar"
          onResize={setLeftSidebarWidth}
        />
      )}
    </aside>
  )
}
