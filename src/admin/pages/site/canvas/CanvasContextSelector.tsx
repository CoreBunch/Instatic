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
import { lazy, Suspense, useRef, useState, type SyntheticEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import type { Breakpoint, ConditionDef } from '@core/page-tree'
import { conditionLabel } from '@core/page-tree'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { Button } from '@ui/components/Button'
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
import type { ContextDialogMode } from './CanvasContextDialog'
import { NotchFold } from './NotchFold'
import styles from './CanvasContextSelector.module.css'

// Stable empty fallbacks so the Zustand selectors keep a reference-stable
// identity when the site / its arrays are absent (Guideline #239 — inline
// `?? []` in a selector returns a fresh array every render → infinite loop).
const EMPTY_BREAKPOINTS: ReadonlyArray<Breakpoint> = []
const EMPTY_CONDITIONS: ReadonlyArray<ConditionDef> = []

const CanvasContextDialog = lazy(() => import('./CanvasContextDialog'))

export function CanvasContextSelector({ compact = false }: { compact?: boolean }) {
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
  const [dialog, setDialog] = useState<ContextDialogMode | null>(null)
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
      <div className={styles.notch} data-canvas-context-notch="">
        <Button
          ref={triggerRef}
          variant="ghost"
          size="micro"
          className={styles.triggerPill}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Editing context: ${activeCondition?.label ?? activeBp?.label ?? ''}`}
          tooltip={compact ? `Editing context: ${activeCondition?.label ?? activeBp?.label}` : 'Editing context'}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {activeConditionValid
            ? <SlidersHorizontalIcon size={12} aria-hidden="true" />
            : <BreakpointIcon name={activeBp?.icon ?? 'monitor'} />}
          <NotchFold compact={compact} className={styles.contextDetails}>
            <span className={styles.triggerLabel}>
              {activeConditionValid ? (activeCondition?.label ?? 'Condition') : (activeBp?.label ?? '')}
            </span>
            <ChevronDownIcon size={10} aria-hidden="true" />
          </NotchFold>
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
        <Suspense fallback={null}>
          <CanvasContextDialog mode={dialog} onClose={() => setDialog(null)} />
        </Suspense>
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
