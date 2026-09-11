/**
 * CanvasContextSelector — the single "editing context" switcher (top-right of
 * the canvas).
 *
 * One control for the whole condition axis (unified-condition-axis plan). A
 * dropdown lists, with one consistent row design (icon · name · detail):
 *   - viewport contexts (from `site.breakpoints`) — selecting one reframes the
 *     canvas and targets that viewport's styles;
 *   - custom conditions (reusable @media / @container / @supports from
 *     `site.conditions`) — selecting one keeps the current frame but routes
 *     style-panel edits to that condition's `contextStyles` bag.
 * Each custom row carries an inline × to delete it; a footer offers
 * "Add context…" and "Manage…". A viewport context stores both a canvas frame
 * width and the media query that publishes its class overrides.
 */
import { useRef, useState, type FormEvent, type SyntheticEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import type { Breakpoint, Condition, ConditionDef } from '@core/page-tree'
import { breakpointMediaQuery, conditionLabel, defaultBreakpointMediaQuery } from '@core/page-tree'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { ConditionBuilder, type ConditionKind } from './ConditionBuilder'
import { SmartphoneSolidIcon } from 'pixel-art-icons/icons/smartphone-solid'
import { TabletSolidIcon } from 'pixel-art-icons/icons/tablet-solid'
import { MonitorSolidIcon } from 'pixel-art-icons/icons/monitor-solid'
import { LaptopSolidIcon } from 'pixel-art-icons/icons/laptop-solid'
import { TvSolidIcon } from 'pixel-art-icons/icons/tv-solid'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { cn } from '@ui/cn'
import styles from './CanvasContextSelector.module.css'

// Stable empty fallbacks so the Zustand selectors keep a reference-stable
// identity when the site / its arrays are absent (Guideline #239 — inline
// `?? []` in a selector returns a fresh array every render → infinite loop).
const EMPTY_BREAKPOINTS: ReadonlyArray<Breakpoint> = []
const EMPTY_CONDITIONS: ReadonlyArray<ConditionDef> = []

/** What the add/edit dialog is doing: closed, adding, or editing one entity. */
type DialogState = 'add' | { bp: Breakpoint } | { def: ConditionDef } | null

export function CanvasContextSelector() {
  const breakpoints = useEditorStore((s) => s.site?.breakpoints ?? EMPTY_BREAKPOINTS)
  const conditions = useEditorStore((s) => s.site?.conditions ?? EMPTY_CONDITIONS)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const activeConditionId = useEditorStore((s) => s.activeConditionId)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const setActiveConditionId = useEditorStore((s) => s.setActiveConditionId)
  const removeCondition = useEditorStore((s) => s.removeCondition)
  const removeBreakpoint = useEditorStore((s) => s.removeBreakpoint)

  const [menuOpen, setMenuOpen] = useState(false)
  // null = closed; 'add' = add a new context; { bp } / { def } = edit that one.
  const [dialog, setDialog] = useState<DialogState>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const stopCanvasInteraction = (event: SyntheticEvent) => {
    event.stopPropagation()
  }

  if (breakpoints.length === 0) return null

  const activeConditionValid = activeConditionId !== null && conditions.some((c) => c.id === activeConditionId)
  const activeCondition = activeConditionValid ? conditions.find((c) => c.id === activeConditionId) : undefined
  const activeBp = breakpoints.find((b) => b.id === activeBreakpointId) ?? breakpoints[0]

  const closeMenu = () => setMenuOpen(false)

  return (
    <div
      className={styles.shell}
      data-testid="canvas-context-selector"
      onClick={stopCanvasInteraction}
      onMouseDown={stopCanvasInteraction}
      aria-label="Editing context"
    >
      <div className={styles.notch}>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="micro"
          className={styles.triggerPill}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Editing context: ${activeCondition?.label ?? activeBp?.label ?? ''}`}
          tooltip="Editing context"
          onClick={() => setMenuOpen((v) => !v)}
        >
          {activeConditionValid
            ? <SlidersHorizontalIcon size={12} aria-hidden="true" />
            : <BreakpointIcon name={activeBp?.icon ?? 'monitor'} />}
          <span className={styles.triggerLabel}>
            {activeConditionValid ? (activeCondition?.label ?? 'Condition') : (activeBp?.label ?? '')}
          </span>
          <ChevronDownIcon size={10} aria-hidden="true" />
        </Button>
      </div>

      {menuOpen && (
        <ContextMenu
          ariaLabel="Editing context"
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          onClose={closeMenu}
          minWidth={236}
          side="bottom"
          align="end"
          menuClassName={styles.menuPanel}
        >
          {breakpoints.map((bp) => {
            const isActive = !activeConditionValid && bp.id === activeBreakpointId
            return (
              <div key={bp.id} className={styles.menuRow}>
                <ContextMenuItem
                  className={cn(styles.menuRowMain, isActive && styles.menuRowActive)}
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => { setActiveBreakpoint(bp.id); closeMenu() }}
                >
                  <BreakpointIcon name={bp.icon} />
                  <span className={styles.rowLabel}>{bp.label}</span>
                  <span className={styles.rowDetail}>{bp.width}px</span>
                </ContextMenuItem>
                <Button
                  variant="ghost"
                  size="micro"
                  className={styles.rowAction}
                  aria-label={`Edit ${bp.label} breakpoint`}
                  tooltip="Edit breakpoint"
                  onClick={(e) => { e.stopPropagation(); closeMenu(); setDialog({ bp }) }}
                >
                  <EditSolidIcon size={11} aria-hidden="true" />
                </Button>
                {breakpoints.length > 1 && (
                  <Button
                    variant="ghost"
                    size="micro"
                    className={styles.rowRemove}
                    aria-label={`Delete ${bp.label} breakpoint`}
                    tooltip="Delete breakpoint"
                    onClick={(e) => { e.stopPropagation(); removeBreakpoint(bp.id) }}
                  >
                    <CloseIcon size={11} aria-hidden="true" />
                  </Button>
                )}
              </div>
            )
          })}

          {conditions.length > 0 && <ContextMenuSeparator />}

          {conditions.map((def) => {
            const isActive = activeConditionValid && def.id === activeConditionId
            const detail = conditionLabel(def.condition)
            const showDetail = def.label.trim() !== detail.trim()
            return (
              <div key={def.id} className={styles.menuRow}>
                <ContextMenuItem
                  className={cn(styles.menuRowMain, isActive && styles.menuRowActive)}
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => { setActiveConditionId(def.id); closeMenu() }}
                >
                  <SlidersHorizontalIcon size={12} aria-hidden="true" />
                  <span className={styles.rowLabel}>{def.label}</span>
                  {showDetail && <span className={styles.rowDetail}>{detail}</span>}
                </ContextMenuItem>
                <Button
                  variant="ghost"
                  size="micro"
                  className={styles.rowAction}
                  aria-label={`Edit ${def.label} condition`}
                  tooltip="Edit condition"
                  onClick={(e) => { e.stopPropagation(); closeMenu(); setDialog({ def }) }}
                >
                  <EditSolidIcon size={11} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="micro"
                  className={styles.rowRemove}
                  aria-label={`Delete ${def.label} condition`}
                  tooltip="Delete condition"
                  onClick={(e) => { e.stopPropagation(); removeCondition(def.id) }}
                >
                  <CloseIcon size={11} aria-hidden="true" />
                </Button>
              </div>
            )
          })}

          <ContextMenuSeparator />

          <ContextMenuItem
            className={styles.menuRowMain}
            onClick={() => { closeMenu(); setDialog('add') }}
          >
            <PlusIcon size={12} aria-hidden="true" />
            <span className={styles.rowLabel}>Add context…</span>
          </ContextMenuItem>
        </ContextMenu>
      )}

      {dialog !== null && (
        <ContextDialog mode={dialog} onClose={() => setDialog(null)} />
      )}
    </div>
  )
}

function BreakpointIcon({ name }: { name: string }) {
  switch (name) {
    case 'smartphone':
      return <SmartphoneSolidIcon size={12} aria-hidden="true" />
    case 'tablet':
      return <TabletSolidIcon size={12} aria-hidden="true" />
    case 'laptop':
      return <LaptopSolidIcon size={12} aria-hidden="true" />
    case 'tv':
      return <TvSolidIcon size={12} aria-hidden="true" />
    case 'monitor':
    default:
      return <MonitorSolidIcon size={12} aria-hidden="true" />
  }
}

// ---------------------------------------------------------------------------
// ContextDialog — one add/edit dialog for both breakpoints and conditions.
// ---------------------------------------------------------------------------

/** Dialog segments: a viewport context, or one of the three condition kinds. */
type SegmentKind = 'breakpoint' | ConditionKind

const CONDITION_KIND_OPTIONS = [
  { value: 'media', label: 'Environment', ariaLabel: 'Environment media query' },
  { value: 'container', label: 'Container', ariaLabel: 'Container query' },
  { value: 'supports', label: 'Supports', ariaLabel: 'Feature query' },
] satisfies ReadonlyArray<{ value: SegmentKind; label: string; ariaLabel: string }>

const BREAKPOINT_SEGMENT = { value: 'breakpoint', label: 'Viewport', ariaLabel: 'Viewport context' } as const

const ICON_OPTIONS = [
  { value: 'smartphone', label: 'Smartphone', icon: <SmartphoneSolidIcon size={13} /> },
  { value: 'tablet', label: 'Tablet', icon: <TabletSolidIcon size={13} /> },
  { value: 'monitor', label: 'Monitor', icon: <MonitorSolidIcon size={13} /> },
  { value: 'laptop', label: 'Laptop', icon: <LaptopSolidIcon size={13} /> },
  { value: 'tv', label: 'TV', icon: <TvSolidIcon size={13} /> },
]

const CONDITION_FORM_ID = 'add-condition-form'

/** Detect a pure width media query. Returns the pixel width, or null. */
function detectWidthPx(query: string): number | null {
  const m = query.trim().match(/^\(?\s*(?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)\s*px\s*\)?$/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Validate that a query parses inside its @-rule via the browser CSS engine,
 * after a structural-safety reject (braces / `;` / `</` could break out of the
 * emitted block or the <style> element — mirrors the publisher's guard).
 */
function isValidConditionQuery(kind: ConditionKind, query: string): boolean {
  const q = query.trim()
  if (!q) return false
  if (/[{}]/.test(q) || /<\//.test(q) || /;/.test(q)) return false
  if (typeof CSSStyleSheet === 'undefined') return true
  const wrapped =
    kind === 'media' ? `@media ${q} {}`
    : kind === 'container' ? `@container ${ensureParens(q)} {}`
    : `@supports ${ensureParens(q)} {}`
  try {
    const sheet = new CSSStyleSheet()
    sheet.insertRule(wrapped)
    return sheet.cssRules.length > 0
  } catch {
    return false
  }
}

function ensureParens(q: string): string {
  const t = q.trim()
  return t.startsWith('(') ? t : `(${t})`
}

function ContextDialog({ mode, onClose }: { mode: Exclude<DialogState, null>; onClose: () => void }) {
  const addCondition = useEditorStore((s) => s.addCondition)
  const updateCondition = useEditorStore((s) => s.updateCondition)
  const addBreakpoint = useEditorStore((s) => s.addBreakpoint)
  const updateBreakpoint = useEditorStore((s) => s.updateBreakpoint)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const setActiveConditionId = useEditorStore((s) => s.setActiveConditionId)

  const editBp = mode !== 'add' && 'bp' in mode ? mode.bp : null
  const editDef = mode !== 'add' && 'def' in mode ? mode.def : null

  const [segment, setSegment] = useState<SegmentKind>(
    editBp ? 'breakpoint' : editDef ? editDef.condition.kind : 'breakpoint',
  )
  // Shared display name (breakpoint label / condition label).
  const [label, setLabel] = useState(editBp ? editBp.label : editDef ? editDef.label : '')
  // Condition fields.
  const [query, setQuery] = useState(editDef ? editDef.condition.query : '')
  const [containerName, setContainerName] = useState(
    editDef && editDef.condition.kind === 'container' ? (editDef.condition.name ?? '') : '',
  )
  const [range, setRange] = useState({ min: '', max: '', unit: 'px' })
  // Breakpoint fields.
  const [bpWidth, setBpWidth] = useState(editBp ? editBp.width : 768)
  const [bpMediaQuery, setBpMediaQuery] = useState(
    editBp ? breakpointMediaQuery(editBp) : defaultBreakpointMediaQuery(768),
  )
  const [bpIcon, setBpIcon] = useState(editBp ? editBp.icon : 'tablet')
  const [bpPreview, setBpPreview] = useState(editBp ? editBp.previewFrame !== false : true)
  const [error, setError] = useState<string | null>(null)

  const isEditBp = editBp !== null
  const isEditDef = editDef !== null
  const onBreakpoint = segment === 'breakpoint'

  // Segments offered: editing locks the entity; adding offers all four.
  const segOptions = isEditBp
    ? [BREAKPOINT_SEGMENT]
    : isEditDef
      ? CONDITION_KIND_OPTIONS
      : [BREAKPOINT_SEGMENT, ...CONDITION_KIND_OPTIONS]

  function handleViewportWidthChange(width: number) {
    const previousDefault = defaultBreakpointMediaQuery(bpWidth)
    setBpWidth(width)
    setError(null)
    if (bpMediaQuery === previousDefault) {
      setBpMediaQuery(defaultBreakpointMediaQuery(width))
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (onBreakpoint) {
      if (!(bpWidth > 0)) { setError('Enter a width in pixels.'); return }
      const mediaQuery = bpMediaQuery.trim() || defaultBreakpointMediaQuery(bpWidth)
      if (!isValidConditionQuery('media', mediaQuery)) {
        setError('That media query is not valid CSS.')
        return
      }
      const name = label.trim() || `${bpWidth}px`
      if (isEditBp && editBp) {
        updateBreakpoint(editBp.id, {
          label: name,
          width: bpWidth,
          mediaQuery,
          icon: bpIcon,
          previewFrame: bpPreview,
        })
        setActiveBreakpoint(editBp.id)
      } else {
        const bp = addBreakpoint({
          label: name,
          width: bpWidth,
          mediaQuery,
          icon: bpIcon,
          previewFrame: bpPreview,
        })
        setActiveBreakpoint(bp.id)
      }
      onClose()
      return
    }

    const kind = segment as ConditionKind
    const q = query.trim()
    if (!isValidConditionQuery(kind, q)) {
      setError('That query is not valid CSS.')
      return
    }
    const condition: Condition =
      kind === 'media' ? { kind: 'media', query: q }
      : kind === 'container' ? { kind: 'container', query: q, ...(containerName.trim() ? { name: containerName.trim() } : {}) }
      : { kind: 'supports', query: q }
    if (isEditDef && editDef) {
      updateCondition(editDef.id, condition, label.trim() || undefined)
      setActiveConditionId(editDef.id)
    } else {
      const id = addCondition(condition, label.trim() || undefined)
      setActiveConditionId(id)
    }
    onClose()
  }

  // Live label preview for conditions.
  const previewLabel = !onBreakpoint && query.trim()
    ? conditionLabel(
        segment === 'container'
          ? { kind: 'container', query: query.trim(), ...(containerName.trim() ? { name: containerName.trim() } : {}) }
          : { kind: segment as ConditionKind, query: query.trim() },
      )
    : ''
  // Nudge width media queries toward the Viewport segment.
  const widthInMedia = segment === 'media' && detectWidthPx(query) !== null
  const title = isEditBp ? 'Edit viewport' : isEditDef ? 'Edit condition' : 'Add context'
  const submitDisabled = onBreakpoint ? !(bpWidth > 0) || !bpMediaQuery.trim() : !query.trim()
  const submitLabel = isEditBp || isEditDef ? 'Save' : onBreakpoint ? 'Add viewport' : 'Add'

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" type="submit" form={CONDITION_FORM_ID} disabled={submitDisabled}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={CONDITION_FORM_ID} className={styles.form} onSubmit={handleSubmit}>
        {segOptions.length > 1 && (
          <SegmentedControl<SegmentKind>
            value={segment}
            options={segOptions}
            onChange={(k) => { setSegment(k); setError(null) }}
            size="sm"
            fullWidth
            aria-label="Context type"
          />
        )}

        <div className={styles.field}>
          <span className={styles.label}>Name</span>
          <Input
            fieldSize="sm"
            value={label}
            placeholder={onBreakpoint ? `${bpWidth || 0}px viewport` : 'e.g. Dark mode'}
            autoComplete="off"
            spellCheck={false}
            aria-label="Display name"
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        {onBreakpoint ? (
          <>
            <div className={styles.field}>
              <span className={styles.label}>Frame width (px)</span>
              <Input
                fieldSize="sm"
                type="number"
                inputMode="numeric"
                value={bpWidth}
                min={1}
                aria-label="Viewport frame width in pixels"
                onChange={(e) => handleViewportWidthChange(Number(e.target.value))}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.label}>CSS media query</span>
              <Input
                fieldSize="sm"
                value={bpMediaQuery}
                placeholder="(min-width: 768px)"
                autoComplete="off"
                spellCheck={false}
                aria-label="Viewport CSS media query"
                onChange={(e) => { setBpMediaQuery(e.target.value); setError(null) }}
              />
              <div className={styles.chips}>
                <Button
                  type="button"
                  size="micro"
                  variant={bpMediaQuery.trim() === defaultBreakpointMediaQuery(bpWidth) ? 'primary' : 'secondary'}
                  onClick={() => { setBpMediaQuery(defaultBreakpointMediaQuery(bpWidth)); setError(null) }}
                >
                  Max-width
                </Button>
                <Button
                  type="button"
                  size="micro"
                  variant={bpMediaQuery.trim() === `(min-width: ${bpWidth}px)` ? 'primary' : 'secondary'}
                  onClick={() => { setBpMediaQuery(`(min-width: ${bpWidth}px)`); setError(null) }}
                >
                  Min-width
                </Button>
              </div>
            </div>
            <div className={styles.field}>
              <span className={styles.label}>Icon</span>
              <Select
                value={bpIcon}
                fieldSize="sm"
                aria-label="Viewport icon"
                options={ICON_OPTIONS}
                onChange={(e) => setBpIcon(e.target.value)}
              />
            </div>
            <div className={styles.toggleRow}>
              <span className={styles.label}>Preview frame on canvas</span>
              <Switch
                checked={bpPreview}
                onCheckedChange={setBpPreview}
                aria-label="Show preview frame on canvas"
              />
            </div>
          </>
        ) : (
          <>
            <ConditionBuilder
              kind={segment as ConditionKind}
              query={query}
              onQueryChange={(q) => { setQuery(q); setError(null) }}
              name={containerName}
              onNameChange={setContainerName}
              range={range}
              onRangeChange={setRange}
            />
            {widthInMedia && (
              <p className={styles.hint} role="status">
                Tip: for viewport width, use the Viewport tab so the context gets a canvas frame.
              </p>
            )}
            {previewLabel && <p className={styles.hint} role="status">Saves as: {previewLabel}</p>}
          </>
        )}

        {error && <p role="alert" className={styles.error}>{error}</p>}
      </form>
    </Dialog>
  )
}
