/**
 * ExportDialog — interactive export UI for the Data workspace.
 *
 * Lets the user choose:
 *   • What to include — site shell toggle, media files toggle
 *   • Tables          — per-table checkboxes (all on by default)
 *   • Scope           — all rows OR only the N rows selected in the grid
 *
 * The dialog builds the ExportRequest, calls exportSiteBundle, triggers a
 * browser download, surfaces success/error via pushToast, and closes on success.
 *
 * Wiring into DataPage / DataSidebar is handled by a separate agent.
 */

import { useId, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Dialog } from '@ui/components/Dialog'
import { Switch } from '@ui/components/Switch'
import { pushToast } from '@ui/components/Toast'
import { exportSiteBundle } from '@core/persistence/cmsTransfer'
import type { DataTableKind, DataTableListItem } from '@core/data/schemas'
import { useExportEstimate } from './useExportEstimate'
import styles from './ExportDialog.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

interface ExportDialogProps {
  open: boolean
  onClose: () => void
  /**
   * All tables currently in the workspace. Each table carries its live
   * `rowCount` from the server — no separate `rowCounts` prop needed.
   */
  tables: DataTableListItem[]
  /** Optional: id of the table currently active in the grid. */
  activeTableId?: string | null
  /** Optional: row ids the user has checked in the grid. */
  selectedRowIds?: string[]
  /**
   * When 'selected', pre-selects the "Only the N rows" scope on open
   * (used when the caller clicks "Export selected" in the bulk-action bar).
   * Defaults to 'all'.
   */
  initialScope?: 'all' | 'selected'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pluralizeRowCount(count: number, kind: DataTableKind): string {
  switch (kind) {
    case 'page':      return count === 1 ? '1 page'      : `${count} pages`
    case 'component': return count === 1 ? '1 component' : `${count} components`
    default:          return count === 1 ? '1 row'        : `${count} rows`
  }
}

function makeTimestampedFilename(): string {
  const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')
  return `site-bundle-${ts}.json`
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Module-level helper (extracted so the React Compiler can compile the
// component body — try/finally inside an async function prevents compilation).
// ---------------------------------------------------------------------------

async function runExport(
  effectiveTableIds: Set<string>,
  scope: 'all' | 'selected',
  selectedRowIds: string[],
  includeMedia: boolean,
  siteShell: boolean,
  setExporting: (v: boolean) => void,
  setError: (msg: string | null) => void,
  onClose: () => void,
): Promise<void> {
  setExporting(true)
  setError(null)

  const filename = makeTimestampedFilename()

  try {
    const blob = await exportSiteBundle({
      tables: Array.from(effectiveTableIds),
      rowIds: scope === 'selected' ? selectedRowIds : undefined,
      includeMedia,
      includeSite: siteShell,
    })

    triggerDownload(blob, filename)

    pushToast({
      kind: 'success',
      title: 'Export complete',
      body: filename,
      location: 'data-workspace',
    })

    onClose()
  } catch (err) {
    console.error('[ExportDialog] Export failed:', err)
    const msg = getErrorMessage(err, 'Unknown export error')
    setError(msg)
    pushToast({
      kind: 'error',
      title: 'Export failed',
      body: msg,
      location: 'data-workspace',
    })
  } finally {
    setExporting(false)
  }
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
  // ── State ────────────────────────────────────────────────────────────────

  const [siteShell, setSiteShell] = useState(true)
  const [includeMedia, setIncludeMedia] = useState(false)
  const [selectedTableIds, setSelectedTableIds] = useState<Set<string>>(
    () => new Set(tables.map((t) => t.id)),
  )
  const [scope, setScope] = useState<'all' | 'selected'>(initialScope)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Reset on open transition ──────────────────────────────────────────────
  //
  // Track the previous `open` value so we can detect the false→true edge and
  // reset all form state. This uses the "getDerivedStateFromProps" hook pattern
  // (calling setState during render) which React handles by re-running the
  // render with the updated state immediately — no intermediate flash.
  //
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders

  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setSiteShell(true)
      setIncludeMedia(false)
      setSelectedTableIds(new Set(tables.map((t) => t.id)))
      setScope(initialScope)
      setExporting(false)
      setError(null)
    }
  }

  // ── Derived values ────────────────────────────────────────────────────────

  const hasSelectedRows = selectedRowIds.length > 0
  const selectedScope   = scope === 'selected' && hasSelectedRows

  // When scope is 'selected', lock the table set to the active table only.
  const effectiveTableIds: Set<string> = selectedScope && activeTableId
    ? new Set([activeTableId])
    : selectedTableIds

  const canExport =
    (effectiveTableIds.size > 0 || siteShell) &&
    (scope === 'all' || selectedRowIds.length > 0)

  // ── Estimate ──────────────────────────────────────────────────────────────

  // Derive rowCounts from the tables array (each table carries its live count
  // from the server list endpoint). Computed inline — no memo needed because
  // the tables array only changes when the workspace refreshes.
  const rowCountsByTableId = Object.fromEntries(tables.map((t) => [t.id, t.rowCount]))

  const estimate = useExportEstimate({
    rowCounts: rowCountsByTableId,
    selectedTableIds: effectiveTableIds,
    scope,
    selectedRowIdCount: selectedRowIds.length,
    includeSite: siteShell,
    includeMedia,
    mediaAssetCount: 0, // caller doesn't provide a cheap count yet
  })

  // ── Ids for accessibility ─────────────────────────────────────────────────

  const scopeGroupId  = useId()
  const errorId       = useId()

  // ── Table toggle handler ──────────────────────────────────────────────────

  function toggleTable(tableId: string, checked: boolean) {
    setSelectedTableIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(tableId)
      else next.delete(tableId)
      return next
    })
  }

  // ── Download handler ──────────────────────────────────────────────────────

  async function handleDownload() {
    if (!canExport || exporting) return
    await runExport(effectiveTableIds, scope, selectedRowIds, includeMedia, siteShell, setExporting, setError, onClose)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Export site"
      size="md"
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            disabled={!canExport || exporting}
            aria-describedby={error ? errorId : undefined}
            onClick={handleDownload}
          >
            {exporting ? 'Exporting…' : 'Download bundle'}
          </Button>
        </>
      }
    >
      <div className={styles.body}>

        {/* ── What to include ──────────────────────────────────────── */}
        <section className={styles.section}>
          <p className={styles.sectionLabel}>What to include</p>

          {/* Site shell toggle */}
          <label className={styles.toggleRow}>
            <Switch
              checked={siteShell}
              onCheckedChange={setSiteShell}
              aria-label="Include site shell"
            />
            <span className={styles.toggleLabelBlock}>
              <span className={styles.toggleLabel}>Site shell</span>
              <span className={styles.toggleHelper}>
                breakpoints, settings, classes
              </span>
            </span>
          </label>

          {/* Media files toggle */}
          <label className={styles.toggleRow}>
            <Switch
              checked={includeMedia}
              onCheckedChange={setIncludeMedia}
              aria-label="Include media files"
            />
            <span className={styles.toggleLabelBlock}>
              <span className={styles.toggleLabel}>Media files</span>
              <span className={styles.toggleHelper}>
                will increase bundle size
              </span>
            </span>
          </label>
        </section>

        {/* ── Tables ───────────────────────────────────────────────── */}
        <section className={styles.section}>
          <p className={styles.sectionLabel}>Tables</p>

          {tables.map((table) => {
            const count   = table.rowCount
            const checked = selectedScope
              ? table.id === activeTableId
              : selectedTableIds.has(table.id)
            const disabled = selectedScope

            return (
              <label key={table.id} className={styles.tableRow}>
                <Checkbox
                  checked={checked}
                  disabled={disabled}
                  boxSize="sm"
                  onCheckedChange={(next) => {
                    if (!disabled) toggleTable(table.id, next)
                  }}
                  aria-label={`Include table ${table.name}`}
                />
                <span className={styles.tableName}>{table.name}</span>
                <span className={styles.tableCount}>
                  {pluralizeRowCount(count, table.kind)}
                </span>
              </label>
            )
          })}
        </section>

        {/* ── Scope ────────────────────────────────────────────────── */}
        <section className={styles.section}>
          <p id={scopeGroupId} className={styles.sectionLabel}>Scope</p>

          <label className={styles.radioRow}>
            <input
              type="radio"
              name="export-scope"
              value="all"
              checked={scope === 'all'}
              className={styles.radioInput}
              onChange={() => setScope('all')}
            />
            All rows of the selected tables
          </label>

          <label className={styles.radioRow}>
            <input
              type="radio"
              name="export-scope"
              value="selected"
              checked={scope === 'selected'}
              disabled={!hasSelectedRows}
              className={styles.radioInput}
              onChange={() => setScope('selected')}
            />
            Only the {selectedRowIds.length} row
            {selectedRowIds.length === 1 ? '' : 's'} I&apos;ve selected in the grid
          </label>
        </section>

        {/* ── Estimated size ───────────────────────────────────────── */}
        <p className={styles.estimate}>
          Estimated size: {estimate.formatted}
        </p>

        {/* ── Inline error ─────────────────────────────────────────── */}
        {error && (
          <p id={errorId} role="alert" className={styles.errorText}>
            {error}
          </p>
        )}

      </div>
    </Dialog>
  )
}
