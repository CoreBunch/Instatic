/**
 * BindingPickerPopover — the single-pane DataMeta picker.
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
import { createPortal } from 'react-dom'
import type { PropertyControl } from '@core/module-engine'
import type { DynamicPropBinding } from '@core/page-tree'
import type { LoopItem, LoopSourceField } from '@core/loops/types'
import type { DataMeta, DataMetaField, DataMetaTable } from '@core/data/schemas'
import { useEditorStore, selectActivePage } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { ContextMenu } from '@ui/components/ContextMenu'
import { EmptyState } from '@ui/components/EmptyState'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { getFieldIcon } from '@admin/pages/data/utils/fieldIcons'
import { isFieldBindable, type PropertyControlKind } from '../bindingCompatibility'
import { _cachedMeta, loadDataMeta } from './cache'
import { SYSTEM_SOURCES, type SystemSourceId } from '../systemSources'
import {
  buildPageFrame,
  buildSiteFrame,
  buildRouteFrame,
} from '@core/templates/contextFrames'
import { getCmsDataTable, previewCmsDataLoopItems } from '@core/persistence/cmsData'
import { dataTablePreviewToLoopItem } from '@core/templates/templatePreviewData'
import { primaryTemplateTableSlug } from '@core/templates'
import {
  deriveFormat,
  formatPreviewValue,
  loopFieldFormat,
  loopFieldMatchesControl,
  type FieldEntry,
  type FieldGroup,
} from './helpers'
import styles from './DynamicBindingControl.module.css'
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
])

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PickerPopoverProps {
  label: string
  control: PropertyControl
  availableFields?: LoopSourceField[]
  sourceLabel?: string
  loopTableId?: string | null
  /**
   * Insert mode — clicks insert a `{source.field}` token and the popover
   * stays open so multiple tokens can be inserted in one session.
   * The parent handles bind mode by calling its `onClose` from
   * within `onPick`.
   */
  insertMode?: boolean
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

export function BindingPickerPopover({
  label,
  control,
  availableFields,
  sourceLabel,
  loopTableId,
  insertMode = false,
  anchorRef,
  triggerRef,
  onClose,
  onPick,
}: PickerPopoverProps) {
  // ─── Meta fetching ─────────────────────────────────────────────────────
  // Lazy initializer picks up the cached value so already-loaded meta is
  // immediately available without a synchronous setState in the effect.
  const [meta, setMeta] = useState<DataMeta | null>(() => _cachedMeta)
  const [metaLoading, setMetaLoading] = useState(false)
  const [metaError, setMetaError] = useState<string | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (_cachedMeta) return // already in state via lazy initializer
    let cancelled = false
    setMetaLoading(true)
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

  // ─── Active page template for auto-scope + frame data ─────────────────
  const activePageTableSlug = useEditorStore((s) => {
    const page = selectActivePage(s)
    return page ? primaryTemplateTableSlug(page) : null
  })

  // Live page/site frames for the per-row value preview. Read off the
  // store so the preview shows the same values bindings will resolve to
  // on the actual page.
  const activePageForFrame = useEditorStore(selectActivePage)
  const activeSite = useEditorStore((s) => s.site)

  const pageFrame = activePageForFrame ? buildPageFrame(activePageForFrame) : null
  const siteFrame = activeSite ? buildSiteFrame(activeSite) : null
  const routeFrame = pageFrame ? buildRouteFrame(pageFrame.permalink) : null

  // Auto-scope precedence:
  //   1. `loopTableId` (Loop bound to a specific data table) — most specific.
  //   2. `activePageTableSlug` (template page) — currentEntry resolves
  //      against this table.
  const scopedTable: DataMetaTable | null = (() => {
    if (!meta) return null
    if (loopTableId) {
      const byId = meta.tables.find((t) => t.id === loopTableId)
      if (byId) return byId
    }
    if (activePageTableSlug) {
      return meta.tables.find((t) => t.slug === activePageTableSlug) ?? null
    }
    return null
  })()

  // Loop scope without a specific table — synthetic fields only.
  const hasLoopOnlyScope = !scopedTable && (availableFields?.length ?? 0) > 0

  // ─── currentEntry preview item ─────────────────────────────────────────
  // The value shown on each row for `currentEntry.X` bindings comes from
  // this LoopItem. Resolution priority:
  //   1. Loop-bound table — fetch the most recent published row so the
  //      preview matches what real iterations will render.
  //   2. Template-page scope — synthesize from the table's field
  //      definitions so the preview is sensible even before any row is
  //      published (titles like "Example Post Title", etc.).
  //   3. Loop-bound with no published rows — fall back to (2).
  // The fetched preview item is stored together with the table id it was
  // fetched for. The value the rows actually consume (`currentEntryItem`) is
  // derived during render and only surfaces the fetched item when it still
  // belongs to the current scope — so changing scope never flashes the
  // previous table's preview values, and there is no setState-in-effect reset.
  const [fetchedEntry, setFetchedEntry] = useState<{
    tableId: string
    item: LoopItem | null
  } | null>(null)

  // No eslint-disable needed here: the only setState (setFetchedEntry) runs
  // inside the async load(), not synchronously in the effect body.
  useEffect(() => {
    if (!scopedTable) return
    let cancelled = false
    const tableId = scopedTable.id

    async function load() {
      // Loop-bound table → prefer real rows.
      if (loopTableId === tableId) {
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
  }, [scopedTable, loopTableId])

  const currentEntryItem =
    fetchedEntry && scopedTable && fetchedEntry.tableId === scopedTable.id
      ? fetchedEntry.item
      : null

  // ─── Field list assembly ───────────────────────────────────────────────
  const controlKind = control.type as PropertyControlKind

  function entryMatchesControl(entry: FieldEntry): boolean {
    if (entry.kind === 'meta') return isFieldBindable(controlKind, entry.field)
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

    // 3. System sources — Page / Site / Route. Always visible (and always
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
      const frame =
        entry.source === 'page'
          ? pageFrame
          : entry.source === 'site'
            ? siteFrame
            : entry.source === 'route'
              ? routeFrame
              : null
      if (!frame) return undefined
      return (frame as unknown as Record<string, unknown>)[entry.field.id]
    }
    return currentEntryItem?.fields[entry.field.id]
  }

  // ─── Auto-scope chip ───────────────────────────────────────────────────
  const isAutoScoped = scopedTable !== null
  const isLoopTableScope =
    isAutoScoped && Boolean(loopTableId) && scopedTable?.id === loopTableId
  const autoScopeChipLabel = scopedTable
    ? isLoopTableScope
      ? `Loop row — ${scopedTable.name}`
      : `Current row — ${scopedTable.name}`
    : ''

  // ─── Render: single field row ──────────────────────────────────────────
  function renderFieldRow(entry: FieldEntry): React.ReactNode {
    if (entry.kind === 'meta') {
      const { field } = entry
      const FieldIcon = getFieldIcon(field.type)
      const bindable = isFieldBindable(controlKind, field)
      const tooltip = !bindable
        ? `Cannot bind a ${field.type} field to a ${control.label} control`
        : undefined
      const rawValue = getFieldPreviewValue(entry)
      const previewText = formatPreviewValue(rawValue)

      return (
        <Button
          key={field.id}
          variant="ghost"
          size="md"
          fullWidth
          align="start"
          disabled={!bindable}
          tooltip={tooltip}
          onClick={() => {
            if (bindable) pickMetaField(field)
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
      const bindable = loopFieldMatchesControl(field, controlKind)
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
    const bindable = loopFieldMatchesControl(field, controlKind)
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

  // The picker portals into <body> via ContextMenu and positions itself
  // below the anchor (the affordance wrapper). `triggerRef` keeps clicks
  // on the {} affordance from counting as outside-clicks so the parent
  // owns the open/close toggle.
  return createPortal(
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
    </ContextMenu>,
    document.body,
  )
}
