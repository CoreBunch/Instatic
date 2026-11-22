/** The design canvas picker for viewport and custom style contexts. */
import { lazy, Suspense, useEffect, useRef, useState, type SyntheticEvent } from 'react'
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
import { CheckIcon } from 'pixel-art-icons/icons/check'
import type { ContextDialogMode } from './CanvasContextDialog'
import { NotchFold } from './NotchFold'
import styles from './CanvasContextSelector.module.css'

// Stable empty fallbacks so the Zustand selectors keep a reference-stable
// identity when the site / its arrays are absent (Guideline #239 — inline
// `?? []` in a selector returns a fresh array every render → infinite loop).
const EMPTY_BREAKPOINTS: ReadonlyArray<Breakpoint> = []
const EMPTY_CONDITIONS: ReadonlyArray<ConditionDef> = []

const CanvasContextDialog = lazy(() => import('./CanvasContextDialog'))

interface ContextSelectorProps {
  phone: boolean
  compact: boolean
  onPickBreakpoint: (id: string) => void
}

export function CanvasContextSelector({ compact, phone, onPickBreakpoint }: ContextSelectorProps) {
  const breakpoints = useEditorStore((s) => s.site?.breakpoints ?? EMPTY_BREAKPOINTS)
  const conditions = useEditorStore((s) => s.site?.conditions ?? EMPTY_CONDITIONS)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const activeConditionId = useEditorStore((s) => s.activeConditionId)
  const setActiveConditionId = useEditorStore((s) => s.setActiveConditionId)
  const removeCondition = useEditorStore((s) => s.removeCondition)
  const removeBreakpoint = useEditorStore((s) => s.removeBreakpoint)

  const [menu, setMenu] = useState<'pick' | 'manage' | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    // The anchored menu is hidden until its first measurement completes.
    const frame = requestAnimationFrame(() => {
      const target = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
        ?? menuRef.current?.querySelector<HTMLButtonElement>('button')
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [menu])
  // null = closed; 'add' = add a new context; { bp } / { def } = edit that one.
  const [dialog, setDialog] = useState<ContextDialogMode | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const stopCanvasInteraction = (event: SyntheticEvent) => {
    event.stopPropagation()
  }

  if (breakpoints.length === 0) return null

  const activeCondition = conditions.find(condition => condition.id === activeConditionId)
  const activeBp = breakpoints.find((b) => b.id === activeBreakpointId) ?? breakpoints[0]

  const label = activeCondition?.label ?? activeBp.label
  const closeMenu = () => setMenu(null)
  const focusTrigger = () => {
    // A new context can replace the trigger's tooltip wrapper during commit.
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  const contexts = [
    ...breakpoints.map(bp => ({
      id: bp.id, label: bp.label, detail: `${bp.width}px`, icon: <BreakpointIcon name={bp.icon} />,
      active: !activeCondition && bp.id === activeBp.id,
      pick: () => onPickBreakpoint(bp.id), edit: { bp }, kind: 'breakpoint',
      remove: breakpoints.length > 1 ? () => removeBreakpoint(bp.id) : null,
    })),
    ...conditions.map(def => {
      const query = conditionLabel(def.condition)
      return {
        id: def.id, label: def.label, detail: def.label.trim() === query.trim() ? null : query,
        icon: <SlidersHorizontalIcon size={12} aria-hidden="true" />,
        active: def.id === activeConditionId,
        pick: () => setActiveConditionId(def.id), edit: { def }, kind: 'condition',
        remove: () => removeCondition(def.id),
      }
    }),
  ]

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
          size={phone ? 'md' : 'xs'}
          iconOnly={phone && compact}
          className={styles.triggerPill}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          aria-label={`Editing context: ${label}`}
          tooltip={compact ? `Editing context: ${label}` : 'Editing context'}
          onClick={() => setMenu(menu ? null : 'pick')}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setMenu('pick')
            }
          }}
        >
          {activeCondition
            ? <SlidersHorizontalIcon size={12} aria-hidden="true" />
            : <BreakpointIcon name={activeBp?.icon ?? 'monitor'} />}
          <NotchFold compact={compact} className={styles.contextDetails}>
            <span className={styles.triggerLabel}>
              {label}
            </span>
            <ChevronDownIcon size={10} aria-hidden="true" />
          </NotchFold>
        </Button>
      </div>

      {menu && (
        <ContextMenu
          ref={menuRef}
          ariaLabel={menu === 'pick' ? 'Editing context' : 'Manage contexts'}
          maxHeight={400}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') focusTrigger()
            if (event.key === 'Tab') {
              event.preventDefault()
              closeMenu()
              focusTrigger()
              return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')]
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const step = event.key === 'ArrowDown' ? 1 : -1
            buttons[(index + step + buttons.length) % buttons.length]?.focus()
          }}
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          onClose={closeMenu}
          minWidth={236}
          side="bottom"
          align="end"
        >
          {contexts.map(context => (
            <div key={`${context.kind}-${context.id}`} className={styles.menuRow}>
              {menu === 'pick' ? (
                <ContextMenuItem
                  role="menuitemradio"
                  aria-checked={context.active}
                  className={styles.menuRowMain}
                  onClick={() => {
                    context.pick()
                    closeMenu()
                    focusTrigger()
                  }}
                >
                  {context.icon}
                  <span className={styles.rowLabel}>{context.label}</span>
                  {context.detail && <span className={styles.rowDetail}>{context.detail}</span>}
                  <span className={styles.check} aria-hidden="true">{context.active && <CheckIcon size={13} />}</span>
                </ContextMenuItem>
              ) : (
                <>
                  <ContextMenuItem
                    className={styles.menuRowMain}
                    aria-label={`Edit ${context.label} ${context.kind}`}
                    onClick={() => { closeMenu(); setDialog(context.edit) }}
                  >
                    <EditSolidIcon size={12} aria-hidden="true" />
                    <span className={styles.rowLabel}>{context.label}</span>
                  </ContextMenuItem>
                  {context.remove && (
                    <ContextMenuItem
                      danger
                      className={styles.remove}
                      aria-label={`Delete ${context.label} ${context.kind}`}
                      onClick={context.remove}
                    >
                      <CloseIcon size={12} aria-hidden="true" />
                    </ContextMenuItem>
                  )}
                </>
              )}
            </div>
          ))}
          <ContextMenuSeparator />
          {menu === 'manage' && (
            <ContextMenuItem className={styles.menuRowMain} onClick={() => { closeMenu(); setDialog('add') }}>
              <PlusIcon size={12} aria-hidden="true" />
              Add context…
            </ContextMenuItem>
          )}
          <ContextMenuItem
            className={styles.menuRowMain}
            onClick={() => setMenu(menu === 'pick' ? 'manage' : 'pick')}
          >
            <SlidersHorizontalIcon size={12} aria-hidden="true" />
            {menu === 'pick' ? 'Manage contexts…' : 'Back to picker'}
          </ContextMenuItem>
        </ContextMenu>
      )}

      {dialog !== null && (
        <Suspense fallback={null}>
          <CanvasContextDialog mode={dialog} onClose={() => {
            setDialog(null)
            focusTrigger()
          }} />
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
