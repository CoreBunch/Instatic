/**
 * ExportDialog — granular "full site export" UI for the Data workspace.
 *
 * A sibling of the Site Import modal: a two-column category navigator (left)
 * with a detail pane (right). Everything is selected by default, so the primary
 * action is a one-click *full export* — a bundle that re-imports into a fresh
 * Instatic instance and reproduces the same site: theme & settings, all content
 * tables + rows, the media library and its folder tree, and published-URL
 * redirects.
 *
 * Content tables are fully granular: opening a table shows a checklist of its
 * rows (pages, posts, components, …) so the operator can include or exclude
 * individual entries, with per-table All / None. Shell, media, folders and
 * redirects are all-or-nothing toggles.
 *
 * Credentials (user passwords, AI keys) and instance-runtime state (sessions,
 * audit logs) are intentionally NOT part of a portable bundle — see
 * `@core/data/bundleSchema`.
 */

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Dialog } from '@ui/components/Dialog'
import { Switch } from '@ui/components/Switch'
import { pushToast } from '@ui/components/Toast'
import { assignRailAccents, railTintVar } from '@ui/railAccent'
import { getExportSummary, submitSiteBundleExport } from '@core/persistence/cmsTransfer'
import { MAIN_BRANCH_ID } from '@core/branches'
import { useActiveBranchId } from '@admin/state/branchStore'
import { listCmsDataRows } from '@core/persistence/cmsData'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { DataRow, DataTableKind, DataTableListItem } from '@core/data/schemas'
import type { ExportRequest, ExportSummary, TableSelection } from '@core/data/bundleSchema'
import { Settings2SolidIcon } from 'pixel-art-icons/icons/settings-2-solid'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { CornerDownLeftIcon } from 'pixel-art-icons/icons/corner-down-left'
import { useExportEstimate } from './useExportEstimate'
import styles from './ExportDialog.module.css'

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

interface ExportDialogProps {
  open: boolean
  onClose: () => void
  /** All tables currently in the workspace, each carrying its live `rowCount`. */
  tables: DataTableListItem[]
  /** Id of the table active in the grid (the one a row selection belongs to). */
  activeTableId?: string | null
  /** Row ids the user has checked in the grid. */
  selectedRowIds?: string[]
  /**
   * When 'selected', opens pre-narrowed to the active table's selected rows
   * (used by the grid's "Export selected" action). Defaults to 'all'.
   */
  initialScope?: 'all' | 'selected'
}

// ---------------------------------------------------------------------------
// Selection model
// ---------------------------------------------------------------------------

type CategoryKind = 'shell' | 'table' | 'media' | 'mediaFolders' | 'redirects'

/** A table is either fully included ('all') or an explicit set of row ids
 *  (an empty set means the table is excluded). */
type TablePick = 'all' | ReadonlySet<string>

interface ExportCategory {
  id: string
  kind: CategoryKind
  label: string
  count: number | null
  available: boolean
  included: boolean
  table?: DataTableListItem
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kindNoun(count: number, kind: DataTableKind): string {
  switch (kind) {
    case 'page':      return count === 1 ? 'page'      : 'pages'
    case 'component': return count === 1 ? 'component' : 'components'
    default:          return count === 1 ? 'entry'     : 'entries'
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

function rowTitle(row: DataRow, table: DataTableListItem): string {
  const primary = row.cells[table.primaryFieldId]
  if (typeof primary === 'string' && primary.trim()) return primary
  return row.slug || '(untitled)'
}

/** Build the initial per-table pick map. */
function initialPicks(
  tables: DataTableListItem[],
  initialScope: 'all' | 'selected',
  activeTableId: string | null | undefined,
  selectedRowIds: string[],
): Map<string, TablePick> {
  const map = new Map<string, TablePick>()
  const rowScoped = initialScope === 'selected' && activeTableId && selectedRowIds.length > 0
  for (const t of tables) {
    if (rowScoped) {
      map.set(t.id, t.id === activeTableId ? new Set(selectedRowIds) : new Set())
    } else {
      map.set(t.id, 'all')
    }
  }
  return map
}

function pickIncluded(pick: TablePick): boolean {
  return pick === 'all' || pick.size > 0
}

// Extracted so the React Compiler can compile the component body — try/finally
// inside an async function prevents compilation.
async function runExport(
  request: ExportRequest,
  setExporting: (v: boolean) => void,
  setError: (msg: string | null) => void,
  onClose: () => void,
): Promise<void> {
  setExporting(true)
  setError(null)
  try {
    submitSiteBundleExport(request)
    pushToast({
      kind: 'success',
      title: 'Export started',
      body: 'Your browser will save the bundle when it is ready.',
      location: 'data-workspace',
    })
    onClose()
  } catch (err) {
    console.error('[ExportDialog] Export failed:', err)
    const msg = getErrorMessage(err, 'Unknown export error')
    setError(msg)
    pushToast({ kind: 'error', title: 'Export failed', body: msg, location: 'data-workspace' })
  } finally {
    setExporting(false)
  }
}

const CATEGORY_ICON: Record<CategoryKind, typeof Settings2SolidIcon> = {
  shell: Settings2SolidIcon,
  table: DatabaseSolidIcon,
  media: ImageSolidIcon,
  mediaFolders: FolderGlyphIcon,
  redirects: CornerDownLeftIcon,
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ExportDialog({
  open,
  onClose,
  tables,
  activeTableId,
  selectedRowIds = [],
  initialScope = 'all',
}: ExportDialogProps) {
  // ── Selection state ───────────────────────────────────────────────────────
  const [siteShell, setSiteShell] = useState(true)
  const [includeMedia, setIncludeMedia] = useState(true)
  const [includeMediaFolders, setIncludeMediaFolders] = useState(true)
  const [includeRedirects, setIncludeRedirects] = useState(true)
  const [picks, setPicks] = useState<Map<string, TablePick>>(
    () => initialPicks(tables, initialScope, activeTableId, selectedRowIds),
  )
  const [activeCategory, setActiveCategory] = useState<string>(
    () => (initialScope === 'selected' && activeTableId ? `table:${activeTableId}` : 'shell'),
  )

  // Lazy-loaded rows per table (only fetched when a table detail is opened).
  const [tableRows, setTableRows] = useState<Map<string, DataRow[]>>(new Map())
  const [loadingTables, setLoadingTables] = useState<Set<string>>(new Set())
  // Tables whose row fetch has already been kicked off — dedupes the lazy load
  // without putting `tableRows`/`loadingTables` in the effect deps (which would
  // re-run the effect mid-fetch and cancel it).
  const requestedTablesRef = useRef<Set<string>>(new Set())

  const [summary, setSummary] = useState<ExportSummary | null>(null)
  const activeBranchId = useActiveBranchId()
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Reset on the closed→open edge (getDerivedStateFromProps pattern) ───────
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setSiteShell(true)
      setIncludeMedia(true)
      setIncludeMediaFolders(true)
      setIncludeRedirects(true)
      setPicks(initialPicks(tables, initialScope, activeTableId, selectedRowIds))
      setActiveCategory(initialScope === 'selected' && activeTableId ? `table:${activeTableId}` : 'shell')
      setTableRows(new Map())
      setLoadingTables(new Set())
      setSummary(null)
      setExporting(false)
      setError(null)
    }
  }

  // ── Load category totals (media / folders / redirects) once per open ───────
  useEffect(() => {
    if (!open) return undefined
    // New open session — forget which tables were already row-fetched.
    requestedTablesRef.current = new Set()
    const controller = new AbortController()
    getExportSummary(controller.signal)
      .then((result) => {
        setSummary(result)
        if (result.media === 0) setIncludeMedia(false)
        if (result.mediaFolders === 0) setIncludeMediaFolders(false)
        if (result.redirects === 0) setIncludeRedirects(false)
      })
      .catch((err) => {
        if (isAbortError(err)) return
        console.error('[ExportDialog] Failed to load export summary:', err)
      })
    return () => controller.abort()
  }, [open])

  // ── Lazy-load rows when a table category is opened ─────────────────────────
  // Deduped via `requestedTablesRef` (not state) so this effect depends only on
  // `open`/`activeCategory` — listing the row/loading state here would re-run it
  // mid-fetch. A late response after close lands on an unmounted component,
  // which React treats as a no-op.
  useEffect(() => {
    if (!open || !activeCategory.startsWith('table:')) return
    const tableId = activeCategory.slice('table:'.length)
    if (requestedTablesRef.current.has(tableId)) return
    requestedTablesRef.current.add(tableId)

    setLoadingTables((prev) => new Set(prev).add(tableId))
    listCmsDataRows(tableId)
      .then((rows) => setTableRows((prev) => new Map(prev).set(tableId, rows)))
      .catch((err) => console.error('[ExportDialog] Failed to load rows for export:', err))
      .finally(() => {
        setLoadingTables((prev) => {
          const next = new Set(prev)
          next.delete(tableId)
          return next
        })
      })
  }, [open, activeCategory])

  // ── Build the export request from the current selection ─────────────────────
  const tableSelections: TableSelection[] = []
  for (const t of tables) {
    const pick = picks.get(t.id) ?? 'all'
    if (pick === 'all') tableSelections.push({ tableId: t.id })
    else if (pick.size > 0) tableSelections.push({ tableId: t.id, rowIds: Array.from(pick) })
  }

  const request: ExportRequest = {
    tables: tableSelections,
    includeMedia,
    includeSite: siteShell,
    includeMediaFolders,
    includeRedirects,
    // The download is a form POST without the branch header: name the branch.
    ...(activeBranchId === MAIN_BRANCH_ID ? {} : { branchId: activeBranchId }),
  }

  const estimate = useExportEstimate(open ? request : null)

  // ── Category list (left navigator) ─────────────────────────────────────────
  const baseCategories: ExportCategory[] = [
    { id: 'shell', kind: 'shell', label: 'Theme & settings', count: null, available: true, included: siteShell },
    ...tables.map<ExportCategory>((table) => {
      const pick = picks.get(table.id) ?? 'all'
      return {
        id: `table:${table.id}`,
        kind: 'table',
        label: table.name,
        count: table.rowCount,
        available: true,
        included: pickIncluded(pick),
        table,
      }
    }),
    {
      id: 'media',
      kind: 'media',
      label: 'Media library',
      count: summary?.media ?? null,
      available: summary === null || summary.media > 0,
      included: includeMedia,
    },
    {
      id: 'mediaFolders',
      kind: 'mediaFolders',
      label: 'Media folders',
      count: summary?.mediaFolders ?? null,
      available: summary === null || summary.mediaFolders > 0,
      included: includeMediaFolders,
    },
    {
      id: 'redirects',
      kind: 'redirects',
      label: 'Redirects',
      count: summary?.redirects ?? null,
      available: summary === null || summary.redirects > 0,
      included: includeRedirects,
    },
  ]

  const accents = assignRailAccents(baseCategories, (c) => `export:${c.id}:${c.label}`)
  const categories = baseCategories.map((c, i) => ({ ...c, tint: railTintVar(accents[i] ?? 'mint') }))
  const active = categories.find((c) => c.id === activeCategory) ?? categories[0]

  const includedCount = categories.filter((c) => c.included).length
  const selectableCount = categories.filter((c) => c.available).length
  const isFullExport =
    includedCount === selectableCount &&
    selectableCount > 0 &&
    tables.every((t) => (picks.get(t.id) ?? 'all') === 'all')

  const canExport = includedCount > 0 && !exporting

  // ── Mutators ────────────────────────────────────────────────────────────────
  function setSimpleIncluded(kind: CategoryKind, next: boolean) {
    if (kind === 'shell') setSiteShell(next)
    else if (kind === 'media') setIncludeMedia(next)
    else if (kind === 'mediaFolders') setIncludeMediaFolders(next)
    else if (kind === 'redirects') setIncludeRedirects(next)
  }

  function setTablePick(tableId: string, pick: TablePick) {
    setPicks((prev) => new Map(prev).set(tableId, pick))
  }

  function toggleRow(tableId: string, rowId: string) {
    const rows = tableRows.get(tableId) ?? []
    setPicks((prev) => {
      const cur = prev.get(tableId) ?? 'all'
      const set = cur === 'all' ? new Set(rows.map((r) => r.id)) : new Set(cur)
      if (set.has(rowId)) set.delete(rowId)
      else set.add(rowId)
      return new Map(prev).set(tableId, set)
    })
  }

  function selectAll() {
    setSiteShell(true)
    setPicks(() => new Map(tables.map((t) => [t.id, 'all' as TablePick])))
    if (summary === null || summary.media > 0) setIncludeMedia(true)
    if (summary === null || summary.mediaFolders > 0) setIncludeMediaFolders(true)
    if (summary === null || summary.redirects > 0) setIncludeRedirects(true)
  }

  function selectNone() {
    setSiteShell(false)
    setPicks(() => new Map(tables.map((t) => [t.id, new Set<string>() as TablePick])))
    setIncludeMedia(false)
    setIncludeMediaFolders(false)
    setIncludeRedirects(false)
  }

  const errorId = useId()

  async function handleDownload() {
    if (!canExport) return
    await runExport(request, setExporting, setError, onClose)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Instatic"
      title="Export site"
      size="2xl"
      bodyClassName={styles.body}
      footer={
        <>
          <span className={styles.footerNote}>
            {isFullExport ? (
              <><strong>Full export</strong> · re-imports into a fresh instance identically</>
            ) : (
              <>{includedCount} of {selectableCount} categories selected</>
            )}
          </span>
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="button"
            disabled={!canExport}
            aria-describedby={error ? errorId : undefined}
            onClick={handleDownload}
          >
            {exporting ? 'Exporting…' : 'Download bundle'}
          </Button>
        </>
      }
    >
      <div className={styles.step}>
        {/* ── Left: category navigator ──────────────────────────────── */}
        <nav className={styles.nav} aria-label="Export categories">
          <p className={styles.navLead}>
            Everything is selected for a <strong>full export</strong>. Untick anything you want to leave out.
          </p>

          <div className={styles.navList}>
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                className={styles.navItem}
                data-active={category.id === active?.id || undefined}
                onClick={() => setActiveCategory(category.id)}
              >
                <span className={styles.navDot} style={{ '--tint': category.tint } as CSSProperties} />
                <span className={styles.navLabel}>{category.label}</span>
                <span className={styles.navCount}>{category.count === null ? '' : category.count}</span>
                <span className={styles.navState} data-on={category.included || undefined} />
              </button>
            ))}
          </div>

          <div className={styles.navBottom}>
            <div className={styles.bulkRow}>
              <button type="button" className={styles.link} onClick={selectAll}>Select all</button>
              <span className={styles.bulkSep}>·</span>
              <button type="button" className={styles.link} onClick={selectNone}>Select none</button>
            </div>
            <p className={styles.estimate}>
              Estimated size&nbsp;·&nbsp;
              <span className={styles.estimateValue}>
                {estimate.error ? 'unavailable' : estimate.formatted}
              </span>
            </p>
          </div>
        </nav>

        {/* ── Right: detail pane ─────────────────────────────────────── */}
        <div className={styles.detail}>
          {active?.kind === 'table' && active.table ? (
            <TableDetail
              table={active.table}
              tint={active.tint}
              pick={picks.get(active.table.id) ?? 'all'}
              rows={tableRows.get(active.table.id)}
              loading={loadingTables.has(active.table.id)}
              onToggleRow={(rowId) => toggleRow(active.table!.id, rowId)}
              onAll={() => setTablePick(active.table!.id, 'all')}
              onNone={() => setTablePick(active.table!.id, new Set())}
            />
          ) : active ? (
            <SimpleDetail
              category={active}
              onToggle={(next) => setSimpleIncluded(active.kind, next)}
            />
          ) : null}

          {error && (
            <p id={errorId} role="alert" className={styles.errorText}>{error}</p>
          )}
        </div>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// TableDetail — per-row checklist for a content table
// ---------------------------------------------------------------------------

interface TableDetailProps {
  table: DataTableListItem
  tint: string
  pick: TablePick
  rows: DataRow[] | undefined
  loading: boolean
  onToggleRow: (rowId: string) => void
  onAll: () => void
  onNone: () => void
}

function TableDetail({ table, tint, pick, rows, loading, onToggleRow, onAll, onNone }: TableDetailProps) {
  const total = rows?.length ?? table.rowCount
  const includedCount = pick === 'all' ? total : pick.size
  const isChecked = (rowId: string) => (pick === 'all' ? true : pick.has(rowId))

  return (
    <>
      <div className={styles.detHead}>
        <span className={styles.detIcon} style={{ '--tint': tint } as CSSProperties}>
          <DatabaseSolidIcon size={16} aria-hidden="true" />
        </span>
        <div className={styles.detHeadText}>
          <h3 className={styles.detTitle}>{table.name}</h3>
          <p className={styles.detSub}>
            {includedCount} of {total} {kindNoun(total, table.kind)} selected
          </p>
        </div>
        <div className={styles.detHeadBulk}>
          <button type="button" className={styles.link} onClick={onAll}>All</button>
          <span className={styles.bulkSep}>·</span>
          <button type="button" className={styles.link} onClick={onNone}>None</button>
        </div>
      </div>

      {loading && rows === undefined ? (
        <p className={styles.loadingNote}>Loading {kindNoun(2, table.kind)}…</p>
      ) : total === 0 ? (
        <p className={styles.emptyNote}>
          This table has no {kindNoun(2, table.kind)} yet — its structure still exports.
        </p>
      ) : (
        <div className={styles.rows}>
          {(rows ?? []).map((row) => (
            <label key={row.id} className={styles.entryRow} data-off={!isChecked(row.id) || undefined}>
              <Checkbox
                checked={isChecked(row.id)}
                boxSize="sm"
                onCheckedChange={() => onToggleRow(row.id)}
                aria-label={`Include ${rowTitle(row, table)}`}
              />
              <span className={styles.entryInfo}>
                <span className={styles.entryTitle}>{rowTitle(row, table)}</span>
                <span className={styles.entryMeta}>
                  /{row.slug}{row.status !== 'published' ? ` · ${row.status}` : ''}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// SimpleDetail — all-or-nothing categories (shell, media, folders, redirects)
// ---------------------------------------------------------------------------

interface SimpleDetailProps {
  category: ExportCategory & { tint: string }
  onToggle: (next: boolean) => void
}

function SimpleDetail({ category, onToggle }: SimpleDetailProps) {
  const Icon = CATEGORY_ICON[category.kind]
  const meta = detailMeta(category)

  return (
    <>
      <div className={styles.detHead}>
        <span className={styles.detIcon} style={{ '--tint': category.tint } as CSSProperties}>
          <Icon size={16} aria-hidden="true" />
        </span>
        <div className={styles.detHeadText}>
          <h3 className={styles.detTitle}>{category.label}</h3>
          <p className={styles.detSub}>{meta.sub}</p>
        </div>
        <Switch
          checked={category.included}
          disabled={!category.available}
          switchSize="sm"
          onCheckedChange={onToggle}
          aria-label={`Include ${category.label} in export`}
        />
      </div>

      {meta.lines.length > 0 && (
        <ul className={styles.factList} data-off={!category.included || undefined}>
          {meta.lines.map((line) => (
            <li key={line} className={styles.factRow}>
              <span className={styles.factDot} style={{ '--tint': category.tint } as CSSProperties} />
              {line}
            </li>
          ))}
        </ul>
      )}

      {!category.available && <p className={styles.emptyNote}>{meta.empty}</p>}
    </>
  )
}

// ---------------------------------------------------------------------------
// Per-category microcopy (non-table categories)
// ---------------------------------------------------------------------------

function detailMeta(category: ExportCategory): { sub: string; lines: string[]; empty: string } {
  switch (category.kind) {
    case 'shell':
      return {
        sub: 'How the site looks and behaves — carried as one unit.',
        lines: [
          'Breakpoints & responsive conditions',
          'Color & type design tokens',
          'Global classes & style rules',
          'Fonts, site files & runtime config',
        ],
        empty: '',
      }
    case 'media': {
      const count = category.count
      return {
        sub: count === null
          ? 'Uploaded images, video and files — embedded so they transfer intact.'
          : `${plural(count, 'file', 'files')} embedded with their bytes — images and video transfer intact.`,
        lines: ['Image & video variants regenerate automatically after import.'],
        empty: 'No media uploaded yet — nothing to export here.',
      }
    }
    case 'mediaFolders': {
      const count = category.count
      return {
        sub: count === null
          ? 'The media library folder tree and each asset’s folder.'
          : `${plural(count, 'folder', 'folders')} — the library tree and where each asset lives.`,
        lines: [],
        empty: 'No folders yet — the library is flat.',
      }
    }
    case 'redirects': {
      const count = category.count
      return {
        sub: count === null
          ? 'Old published URLs keep pointing at the right page after import.'
          : `${plural(count, 'redirect', 'redirects')} — old URLs keep resolving to the right page.`,
        lines: [],
        empty: 'No redirects yet — none have been created.',
      }
    }
    default:
      return { sub: '', lines: [], empty: '' }
  }
}
