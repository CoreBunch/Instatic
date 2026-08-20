/**
 * DataBindingPicker — shared single-pane picker for inserting tokens or
 * creating structured data bindings.
 *
 * Rendered as a non-modal popover anchored to the affordance button (same
 * ContextMenu primitive ClassPicker uses for its dropdown). Clicking a
 * field row IS the action — no Confirm / Cancel:
 *
 *   - Insert mode (string controls): each click inserts a `{token}` at the
 *     input's caret and the popover STAYS OPEN, so multiple tokens can be
 *     inserted in one session. Close by clicking the {} affordance again,
 *     pressing Escape, or clicking outside.
 *   - Bind mode (image / media replacement): clicking a field commits a
 *     structured binding and the parent closes the popover.
 *
 * Groups, top to bottom:
 *   1. Auto-scoped table fields (template page or loop-bound table)
 *   2. Loop metadata (synthetic fields not already in the table)
 *   3. System sources (Page / Site / Route) — one group per source
 *
 * DataMeta is fetched once and cached module-level in `./cache.ts`.
 */

import { useEffect, useState, type RefObject } from 'react'
import type { PropertyControl } from '@core/module-engine'
import type { DynamicPropBinding } from '@core/page-tree'
import type { LoopItem, LoopSourceField } from '@core/loops/types'
import type { DataMeta, DataMetaField, DataMetaTable, DataRow } from '@core/data/schemas'
import { Button } from '@ui/components/Button'
import { ContextMenu } from '@ui/components/ContextMenu'
import { EmptyState } from '@ui/components/EmptyState'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { getFieldIcon } from '@admin/pages/data/utils/fieldIcons'
import { isFieldBindable, type PropertyControlKind } from './bindingCompatibility'
import { _cachedMeta, loadDataMeta } from './cache'
import { SYSTEM_SOURCES, type SystemSourceId } from './systemSources'
import { getCmsDataTable, previewCmsDataLoopItems } from '@core/persistence/cmsData'
import { dataTablePreviewToLoopItem } from '@core/templates/templatePreviewData'
import {
  deriveFormat,
  formatMetaFieldPreview,
  formatPreviewValue,
  loopFieldFormat,
  loopFieldMatchesControl,
  type FieldEntry,
  type FieldGroup,
} from './helpers'
import { useGlobalDataRows } from './useGlobalDataRows'
import styles from './DataBindingPicker.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

// ---------------------------------------------------------------------------
// Icons for loop / system source field formats
//
// Resolved at module load (not inside the component) so the linter does not
// flag them as "components created during render".
// ---------------------------------------------------------------------------

const LoopRichTextIcon = getFieldIcon('richText')
const LoopUrlIcon = getFieldIcon('url')
const LoopPlainTextIcon = getFieldIcon('text')

function LoopFieldIcon({ format }: { format?: LoopSourceField['format'] }) {
  if (format === 'media') return <ImageSolidIcon size={12} aria-hidden="true" />
  if (format === 'html') return <LoopRichTextIcon size={12} aria-hidden="true" />
  if (format === 'url') return <LoopUrlIcon size={12} aria-hidden="true" />
  return <LoopPlainTextIcon size={12} aria-hidden="true" />
}

// Loop synthetic fields that only make sense on `postType` tables. Hidden
// from the loop-metadata group when scoped to a `kind: 'data'` table (no
// body, featured media, SEO, etc.).
const POST_TYPE_ONLY_LOOP_FIELDS = new Set([
  'title',
  'body',
  'featuredMedia',
  'firstImage',
  'seoTitle',
  'seoDescription',
])

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type SystemPreviewValues = Partial<
  Record<SystemSourceId, object | null>
>

export interface DataBindingPickerProps {
  label: string
  control: PropertyControl
  availableFields?: LoopSourceField[]
  sourceLabel?: string
  /** Table scope for currentEntry fields. Id takes precedence over slug. */
  scopedTableId?: string | null
  scopedTableSlug?: string | null
  /** Prefix shown in the scope chip, e.g. "Current entry" or "Loop row". */
  scopeLabel?: string
  /**
   * Current values shown as row previews. When omitted, the picker loads a
   * representative row for the scoped table.
   */
  previewFields?: Record<string, unknown> | null
  /** Prefer a real published row before falling back to synthetic previews. */
  loadPublishedPreview?: boolean
  /** Optional page/site/route values used by system-source preview pills. */
  systemPreviewValues?: SystemPreviewValues
  /**
   * Insert mode — clicks insert a `{source.field}` token and the popover
   * stays open so multiple tokens can be inserted in one session.
   * The parent handles bind mode by calling its `onClose` from
   * within `onPick`.
   */
  insertMode?: boolean
  /**
   * Structured bindings must match the destination control. Token insertion
   * can select any field because interpolation serializes whole media and
   * repeater values as well as scalar values.
   */
  fieldSelectionMode?: 'compatible' | 'token'
  /**
   * Element the popover positions itself against. Typically the affordance
   * wrapper (input + {} button). The popover opens below this element and
   * spans its width (clamped to the picker's min width).
   */
  anchorRef: RefObject<HTMLElement | null>
  /**
   * The affordance button. Clicks on it while the popover is open do NOT
   * count as outside-clicks, so the parent's open/close toggle stays in
   * charge of state.
   */
  triggerRef: RefObject<HTMLElement | null>
  /** Fires when the user dismisses the popover (outside click, Escape). */
  onClose: () => void
  /**
   * Fires when the user clicks a field row. In insert mode the parent
   * inserts a token and leaves the popover open; in bind mode the parent
   * commits the binding and calls `onClose`.
   */
  onPick: (binding: DynamicPropBinding) => void
}

export function DataBindingPicker({
  label,
  control,
  availableFields,
  sourceLabel,
  scopedTableId,
  scopedTableSlug,
  scopeLabel = 'Current row',
  previewFields,
  loadPublishedPreview = false,
  systemPreviewValues,
  insertMode = false,
  fieldSelectionMode = 'compatible',
  anchorRef,
  triggerRef,
  onClose,
  onPick,
}: DataBindingPickerProps) {
  // ─── Meta fetching ─────────────────────────────────────────────────────
  // Lazy initializer picks up the cached value so already-loaded meta is
  // immediately available without a synchronous setState in the effect.
  const [meta, setMeta] = useState<DataMeta | null>(() => _cachedMeta)
  const [metaLoading, setMetaLoading] = useState(() => _cachedMeta === null)
  const [metaError, setMetaError] = useState<string | null>(null)

  useEffect(() => {
    if (_cachedMeta) return // already in state via lazy initializer
    let cancelled = false
    loadDataMeta()
      .then((m) => {
        if (cancelled) return
        setMeta(m)
        setMetaLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setMetaError(getErrorMessage(err, 'Failed to load data meta'))
        setMetaLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const globalRowsByTable = useGlobalDataRows(meta)

  // Table id is the strongest scope signal. Site templates can instead
  // provide a slug; Content supplies its selected collection id.
  const scopedTable: DataMetaTable | null = (() => {
    if (!meta) return null
    if (scopedTableId) {
      const byId = meta.tables.find((t) => t.id === scopedTableId)
      if (byId) return byId
    }
    if (scopedTableSlug) {
      return meta.tables.find((t) => t.slug === scopedTableSlug) ?? null
    }
    return null
  })()

  // Loop scope without a specific table — synthetic fields only.
  const hasLoopOnlyScope = !scopedTable && (availableFields?.length ?? 0) > 0

  // ─── currentEntry preview item ─────────────────────────────────────────
  // When the caller does not provide live preview fields, the value shown
  // for `currentEntry.X` comes from a representative LoopItem:
  //   1. Loop-bound table — fetch the most recent published row so the
  //      preview matches what real iterations will render.
  //   2. Template-page scope — synthesize from the table's field
  //      definitions so the preview is sensible even before any row is
  //      published (titles like "Example Post Title", etc.).
  //   3. Loop-bound with no published rows — fall back to (2).
  // The fetched item is stored with its table id so changing scope never
  // flashes preview values from the previous table.
  const [fetchedEntry, setFetchedEntry] = useState<{
    tableId: string
    item: LoopItem | null
  } | null>(null)
  const hasProvidedPreview = previewFields !== undefined

  // No eslint-disable needed here: the only setState (setFetchedEntry) runs
  // inside the async load(), not synchronously in the effect body.
  useEffect(() => {
    if (!scopedTable || hasProvidedPreview) return
    let cancelled = false
    const tableId = scopedTable.id

    async function load() {
      // Loop and content scopes can prefer a real row so previews match the
      // values authors are working with.
      if (loadPublishedPreview) {
        try {
          const result = await previewCmsDataLoopItems(tableId, {
            limit: 1,
            orderBy: 'publishedAt',
            direction: 'desc',
          })
          if (cancelled) return
          if (result.items.length > 0) {
            setFetchedEntry({ tableId, item: result.items[0] ?? null })
            return
          }
        } catch {
          if (cancelled) return
          // fall through to synthetic
        }
      }
      // Template-page scope (or loop fallback) → synthetic preview from
      // the full DataTable schema.
      try {
        const table = await getCmsDataTable(tableId)
        if (cancelled || !table) return
        setFetchedEntry({ tableId, item: dataTablePreviewToLoopItem(table) })
      } catch {
        if (cancelled) return
        setFetchedEntry({ tableId, item: null })
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [scopedTable, loadPublishedPreview, hasProvidedPreview])

  const currentEntryFields = previewFields ??
    (fetchedEntry && scopedTable && fetchedEntry.tableId === scopedTable.id
      ? fetchedEntry.item?.fields
      : null)

  // ─── Field list assembly ───────────────────────────────────────────────
  const controlKind = control.type as PropertyControlKind

  function entryMatchesControl(entry: FieldEntry): boolean {
    if (fieldSelectionMode === 'token') return true
    if (entry.kind === 'meta' || entry.kind === 'data') {
      return isFieldBindable(controlKind, entry.field)
    }
    return loopFieldMatchesControl(entry.field, controlKind)
  }

  // All applicable groups, top to bottom. Computed once based on context —
  // no source-selection step in between. Authors see every usable binding
  // at once and just click the one they want.
  const groups: FieldGroup[] = (() => {
    const result: FieldGroup[] = []

    // 1. Scoped table fields — leads when auto-scoped.
    if (scopedTable) {
      const tableEntries: FieldEntry[] = scopedTable.fields.map((f) => ({
        kind: 'meta' as const,
        field: f,
      }))
      result.push({ label: `${scopedTable.name} fields`, entries: tableEntries })

      // Loop synthetics not already present in the table.
      if (availableFields && availableFields.length > 0) {
        const tableFieldIds = new Set(scopedTable.fields.map((f) => f.id))
        const loopEntries: FieldEntry[] = availableFields
          .filter((f) => !tableFieldIds.has(f.id))
          .filter(
            (f) =>
              scopedTable.kind === 'postType' || !POST_TYPE_ONLY_LOOP_FIELDS.has(f.id),
          )
          .map((f) => ({ kind: 'loop' as const, field: f }))
        if (loopEntries.length > 0) {
          result.push({ label: 'Loop metadata', entries: loopEntries })
        }
      }
    } else if (hasLoopOnlyScope) {
      // 2. Loop-only scope — synthetic fields directly.
      const loopEntries: FieldEntry[] = (availableFields ?? []).map((f) => ({
        kind: 'loop' as const,
        field: f,
      }))
      result.push({
        label: sourceLabel ? `${sourceLabel} fields` : 'Loop metadata',
        entries: loopEntries,
      })
    }

    // 3. Custom data rows — globally addressable by immutable row id, so
    // ordinary pages can reuse singleton/config values without a loop.
    if (!scopedTable && !hasLoopOnlyScope && meta) {
      for (const table of meta.tables) {
        if (table.kind !== 'data' || table.system) continue
        for (const row of globalRowsByTable[table.id] ?? []) {
          const rowLabel = formatPreviewValue(row.cells[table.primaryFieldId]) || 'Untitled row'
          const entries: FieldEntry[] = table.fields.map((field) => ({
            kind: 'data' as const,
            table,
            row,
            field,
          }))
          result.push({ label: `${table.name} — ${rowLabel}`, entries })
        }
      }
    }

    // 4. System sources — Page / Site / Route. Always visible (and always
    // reachable) since the publisher seeds these frames on every render.
    for (const source of SYSTEM_SOURCES) {
      const entries: FieldEntry[] = source.fields.map((f) => ({
        kind: 'system' as const,
        source: source.id,
        field: f,
      }))
      result.push({ label: source.label, entries })
    }

    return result
      .map((group) => ({
        ...group,
        entries: group.entries.filter(entryMatchesControl),
      }))
      .filter((group) => group.entries.length > 0)
  })()

  // Show the empty hint when the current scope has nothing usable for this
  // control after filtering out incompatible/internal fields.
  const hasNoUsableFields = groups.length === 0

  // ─── Table existence (for the footer hint) ─────────────────────────────
  // When there are tables in the system but the current scope can't reach
  // them, surface the loop / template workflow as guidance.
  const tablesExist = (meta?.tables.length ?? 0) > 0
  const showWorkflowHint = !scopedTable && !hasLoopOnlyScope && tablesExist

  // ─── Click handlers — one shot per click ──────────────────────────────
  function pickMetaField(field: DataMetaField) {
    const format = deriveFormat(controlKind, field.type)
    onPick({
      source: 'currentEntry',
      field: field.id,
      ...(format !== undefined ? { format } : {}),
    })
  }

  function pickDataField(row: DataRow, field: DataMetaField) {
    const format = deriveFormat(controlKind, field.type)
    onPick({
      source: 'data',
      field: `${row.id}.${field.id}`,
      ...(format !== undefined ? { format } : {}),
    })
  }

  function pickLoopField(field: LoopSourceField) {
    const format = loopFieldFormat(field.format)
    onPick({
      source: 'currentEntry',
      field: field.id,
      ...(format !== undefined ? { format } : {}),
    })
  }

  function pickSystemField(source: SystemSourceId, field: LoopSourceField) {
    const format = loopFieldFormat(field.format)
    onPick({
      source,
      field: field.id,
      ...(format !== undefined ? { format } : {}),
    })
  }

  // ─── Per-row value preview ─────────────────────────────────────────────
  function getFieldPreviewValue(entry: FieldEntry): unknown {
    if (entry.kind === 'system') {
      const frame = systemPreviewValues?.[entry.source]
      if (!frame) return undefined
      return (frame as Record<string, unknown>)[entry.field.id]
    }
    if (entry.kind === 'data') return entry.row.cells[entry.field.id]
    return currentEntryFields?.[entry.field.id]
  }

  // ─── Auto-scope chip ───────────────────────────────────────────────────
  const isAutoScoped = scopedTable !== null
  const autoScopeChipLabel = scopedTable
    ? `${scopeLabel} — ${scopedTable.name}`
    : ''

  // ─── Render: single field row ──────────────────────────────────────────
  function renderFieldRow(entry: FieldEntry): React.ReactNode {
    if (entry.kind === 'meta' || entry.kind === 'data') {
      const { field } = entry
      const FieldIcon = getFieldIcon(field.type)
      const bindable =
        fieldSelectionMode === 'token' || isFieldBindable(controlKind, field)
      const tooltip = !bindable
        ? `Cannot bind a ${field.type} field to a ${control.label} control`
        : undefined
      const rawValue = getFieldPreviewValue(entry)
      const previewText = formatMetaFieldPreview(field, rawValue)

      return (
        <Button
          key={entry.kind === 'data' ? `${entry.row.id}.${field.id}` : field.id}
          variant="ghost"
          size="md"
          fullWidth
          align="start"
          disabled={!bindable}
          tooltip={tooltip}
          onClick={() => {
            if (!bindable) return
            if (entry.kind === 'data') pickDataField(entry.row, field)
            else pickMetaField(field)
          }}
          type="button"
        >
          <span className={styles.fieldRowInner}>
            <span className={styles.fieldTypeIcon}>
              {field.type === 'media' && field.mediaKind === 'video' ? (
                <VideoSolidIcon size={12} aria-hidden="true" />
              ) : (
                <FieldIcon size={12} aria-hidden="true" />
              )}
            </span>
            <span className={styles.fieldRowText}>
              <span className={styles.fieldLabel}>{field.label}</span>
            </span>
            <span className={styles.fieldValue} title={previewText}>{previewText}</span>
          </span>
        </Button>
      )
    }

    if (entry.kind === 'system') {
      const { source, field } = entry
      const bindable =
        fieldSelectionMode === 'token' || loopFieldMatchesControl(field, controlKind)
      const tooltip = !bindable
        ? `Cannot bind this ${source} field to a ${control.label} control`
        : undefined
      const rawValue = getFieldPreviewValue(entry)
      const previewText = formatPreviewValue(rawValue)

      return (
        <Button
          key={`${source}.${field.id}`}
          variant="ghost"
          size="md"
          fullWidth
          align="start"
          disabled={!bindable}
          tooltip={tooltip}
          onClick={() => {
            if (bindable) pickSystemField(source, field)
          }}
          type="button"
        >
          <span className={styles.fieldRowInner}>
            <span className={styles.fieldTypeIcon}>
              <LoopFieldIcon format={field.format} />
            </span>
            <span className={styles.fieldRowText}>
              <span className={styles.fieldLabel}>{field.label}</span>
            </span>
            <span className={styles.fieldValue} title={previewText}>{previewText}</span>
          </span>
        </Button>
      )
    }

    // Loop source field.
    const { field } = entry
    const bindable =
      fieldSelectionMode === 'token' || loopFieldMatchesControl(field, controlKind)
    const tooltip = !bindable
      ? `Cannot bind this loop field to a ${control.label} control`
      : undefined
    const rawValue = getFieldPreviewValue(entry)
    const previewText = formatPreviewValue(rawValue)

    return (
      <Button
        key={`loop.${field.id}`}
        variant="ghost"
        size="md"
        fullWidth
        align="start"
        disabled={!bindable}
        tooltip={tooltip}
        onClick={() => {
          if (bindable) pickLoopField(field)
        }}
        type="button"
      >
        <span className={styles.fieldRowInner}>
          <span className={styles.fieldTypeIcon}>
            <LoopFieldIcon format={field.format} />
          </span>
          <span className={styles.fieldRowText}>
            <span className={styles.fieldLabel}>{field.label}</span>
          </span>
          <span className={styles.fieldValue} title={previewText}>{previewText}</span>
        </span>
      </Button>
    )
  }

  // ─── Render: the body inside the popover ──────────────────────────────
  function renderBody() {
    if (metaLoading) {
      return <SkeletonBlock minHeight={200} ariaLabel="Loading data tables" />
    }
    if (metaError) {
      return (
        <div className={styles.pickerEmptyWrapper}>
          <EmptyState
            variant="centered"
            title="Could not load tables"
            description={metaError}
          />
        </div>
      )
    }

    return (
      <>
        {/* Auto-scope chip — shown whenever we have a specific table scope */}
        {isAutoScoped && scopedTable && (
          <div
            className={styles.scopeChip}
            aria-label={`Scoped to ${scopedTable.name}`}
          >
            <span className={styles.scopeChipDot} aria-hidden="true" />
            {autoScopeChipLabel}
          </div>
        )}

        <div className={styles.fieldList}>
          {hasNoUsableFields && (
            <p className={styles.incompatibleHint}>
              No fields in the available sources are compatible with this control.
            </p>
          )}
          {groups.map((group) => (
            <div key={group.label} className={styles.fieldGroup}>
              <div className={styles.fieldGroupHeader}>
                <span className={styles.fieldGroupHeaderText}>{group.label}</span>
                <span className={styles.fieldGroupHeaderCount}>
                  {group.entries.length}
                </span>
              </div>
              {group.entries.map(renderFieldRow)}
            </div>
          ))}
        </div>

        {/* Subtle footer hint pointing at the loop / template workflow
            when there are tables in the system but the current node can't
            bind to them. Lives outside the scrolling list so it doesn't
            compete with the field rows above. */}
        {showWorkflowHint && (
          <p className={styles.subtleHint}>
            Wrap in a Loop or open a postType template to bind to row fields.
          </p>
        )}
      </>
    )
  }

  const popoverLabel = insertMode
    ? `Insert binding for ${label}`
    : `Bind ${label}`

  // ContextMenu owns the body portal and positions the picker below the
  // supplied anchor. `triggerRef` keeps clicks on the braces affordance from
  // counting as outside clicks so the caller owns the open/close toggle.
  return (
    <ContextMenu
      ariaLabel={popoverLabel}
      onClose={onClose}
      anchorRef={anchorRef}
      triggerRef={triggerRef}
      side="auto"
      align="start"
      offset={6}
      matchAnchorWidth
      minWidth={320}
      maxHeight={460}
      zIndex={10000}
      menuClassName={styles.popoverMenu}
    >
      {renderBody()}
    </ContextMenu>
  )
}
