/**
 * CodeDock — the God Mode bottom region hosting the HTML | CSS | JS code
 * panels: layout, per-column show/hide, column and height resizing,
 * narrow-window tab fallback, and layout persistence (via the uiSlice fields
 * projected by siteEditorLayoutPersistence). The columns host the HTML
 * projection editor (`./html`), the live style-rule editor (`./css`) and
 * the page-script editor (`./js`).
 *
 * Resize model (matches SidebarResizeHandle's): pointer drags write CSS
 * custom properties on the dock element imperatively for a 60fps live drag,
 * and commit to the store once on pointer-up — so the localStorage
 * persistence subscriber fires once per gesture, not per mousemove.
 * Keyboard resizes are discrete and commit immediately.
 *
 * Any one panel can be EXPANDED into a full-size dialog for a bigger
 * editing area; while expanded it renders only there, and its column shows
 * a placeholder until the dialog closes. The move remounts the panel, which
 * is why the panels keep their unapplied drafts in the store
 * (`codeDockDrafts`) rather than in component state.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import {
  clampCodeDockHeight,
  type CodeDockColumnWeights,
  type CodeDockPanelId,
} from '@site/store/slices/codeDockSlice'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { ArrowsScaleIcon } from 'pixel-art-icons/icons/arrows-scale'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { cn } from '@ui/cn'
import { HtmlPanel } from './html'
import { CssPanel } from './css'
import { JsPanel } from './js'
import type { RuntimeScriptValidationState } from '@site/hooks/useRuntimeScriptDiagnostics'
import styles from './CodeDock.module.css'

const PANELS: ReadonlyArray<{ id: CodeDockPanelId; label: string }> = [
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'js', label: 'JS' },
]

/**
 * A column's minimum width: a divider drag stops here, the column group's
 * CSS `min-width` holds it, and when the visible columns cannot all fit at
 * it the dock switches to tabbed mode.
 */
const MIN_COLUMN_WIDTH = 280
const KEYBOARD_RESIZE_STEP = 16

/**
 * Wire move/up/cancel listeners for a pointer-captured drag. `onEnd(commit)`
 * always runs exactly once: commit=true on pointerup, commit=false on
 * pointercancel (alt-tab, OS gesture) so an interrupted drag reverts to the
 * stored value instead of leaking listeners and live CSS overrides.
 */
function trackPointerDrag(
  handle: HTMLElement,
  pointerId: number,
  onMove: (event: PointerEvent) => void,
  onEnd: (commit: boolean) => void,
): void {
  handle.setPointerCapture(pointerId)
  const finish = (commit: boolean) => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onCancel)
    onEnd(commit)
  }
  const onUp = () => finish(true)
  const onCancel = () => finish(false)
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onCancel)
}

interface CodeDockProps {
  /** Compiler diagnostics for site scripts, shown inline by the JS panel. */
  runtimeValidation?: RuntimeScriptValidationState
}

export function CodeDock({ runtimeValidation }: CodeDockProps) {
  const dockRef = useRef<HTMLDivElement | null>(null)
  const height = useEditorStore((s) => s.codeDockHeight)
  const panels = useEditorStore((s) => s.codeDockPanels)
  const activeTab = useEditorStore((s) => s.codeDockActiveTab)
  const weights = useEditorStore((s) => s.codeDockColumnWeights)
  const setCodeDockHeight = useEditorStore((s) => s.setCodeDockHeight)
  const toggleCodeDockPanel = useEditorStore((s) => s.toggleCodeDockPanel)
  const setCodeDockActiveTab = useEditorStore((s) => s.setCodeDockActiveTab)
  const setCodeDockColumnWeights = useEditorStore((s) => s.setCodeDockColumnWeights)
  const setPropertiesPanelMode = useEditorStore((s) => s.setPropertiesPanelMode)
  const setPropertiesPanel = useEditorStore((s) => s.setPropertiesPanel)

  const visiblePanels = PANELS.filter((p) => panels[p.id])
  const [expanded, setExpanded] = useState<CodeDockPanelId | null>(null)

  // Narrow-window fallback: when the visible columns can't all fit at their
  // minimum width, collapse to one tabbed editor. Driven by a ResizeObserver
  // on the dock element so window and sidebar resizes both count.
  const [dockWidth, setDockWidth] = useState<number | null>(null)
  useEffect(() => {
    const el = dockRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (typeof width === 'number') setDockWidth(width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const tabbed =
    dockWidth !== null &&
    visiblePanels.length > 1 &&
    dockWidth < visiblePanels.length * MIN_COLUMN_WIDTH

  const openFloatingProperties = () => {
    // Escape hatch: module-specific controls (image pickers, form settings)
    // have no code representation, so Properties stays reachable as a
    // floating window while the docked sidebar is suppressed.
    setPropertiesPanelMode('floating')
    setPropertiesPanel({ collapsed: false })
  }

  // ── Height drag ──────────────────────────────────────────────────────────
  const onHeightPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const el = dockRef.current
    if (!el) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    let liveHeight = startHeight
    trackPointerDrag(
      event.currentTarget,
      event.pointerId,
      (move) => {
        liveHeight = clampCodeDockHeight(startHeight + (startY - move.clientY))
        el.style.setProperty('--code-dock-height', `${liveHeight}px`)
      },
      (commit) => {
        el.style.removeProperty('--code-dock-height')
        if (commit) setCodeDockHeight(liveHeight)
      },
    )
  }

  const onHeightKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCodeDockHeight(height + KEYBOARD_RESIZE_STEP)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCodeDockHeight(height - KEYBOARD_RESIZE_STEP)
    }
  }

  // ── Column divider drag ──────────────────────────────────────────────────
  // A divider sits between visible columns i and i+1 and redistributes width
  // between exactly those two, leaving the rest untouched.
  const onDividerPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    leftId: CodeDockPanelId,
    rightId: CodeDockPanelId,
  ) => {
    if (event.button !== 0) return
    const el = dockRef.current
    if (!el) return
    event.preventDefault()
    const startX = event.clientX
    const columnsWidth = el.clientWidth
    const totalWeight = visiblePanels.reduce((sum, p) => sum + weights[p.id], 0)
    const pxPerWeight = columnsWidth / totalWeight
    const startLeftPx = weights[leftId] * pxPerWeight
    const startRightPx = weights[rightId] * pxPerWeight
    const pairPx = startLeftPx + startRightPx
    let liveWeights: CodeDockColumnWeights = { ...weights }
    const handle = event.currentTarget
    handle.dataset.dragging = 'true'
    trackPointerDrag(
      handle,
      event.pointerId,
      (move) => {
        const delta = move.clientX - startX
        const leftPx = Math.min(
          pairPx - MIN_COLUMN_WIDTH,
          Math.max(MIN_COLUMN_WIDTH, startLeftPx + delta),
        )
        liveWeights = {
          ...weights,
          [leftId]: leftPx / pxPerWeight,
          [rightId]: (pairPx - leftPx) / pxPerWeight,
        }
        el.style.setProperty(`--code-dock-weight-${leftId}`, String(liveWeights[leftId]))
        el.style.setProperty(`--code-dock-weight-${rightId}`, String(liveWeights[rightId]))
      },
      (commit) => {
        delete handle.dataset.dragging
        for (const panel of PANELS) el.style.removeProperty(`--code-dock-weight-${panel.id}`)
        if (commit) setCodeDockColumnWeights(liveWeights)
      },
    )
  }

  const weightStyle = {
    '--code-dock-height': `${height}px`,
    '--code-dock-column-min': `${MIN_COLUMN_WIDTH}px`,
    '--code-dock-weight-html': weights.html,
    '--code-dock-weight-css': weights.css,
    '--code-dock-weight-js': weights.js,
  } as CSSProperties

  return (
    <section
      ref={dockRef}
      className={styles.dock}
      style={weightStyle}
      aria-label="Code Dock"
      data-testid="code-dock"
      data-tabbed={tabbed ? 'true' : 'false'}
    >
      <div
        className={styles.heightHandle}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize Code Dock"
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={onHeightPointerDown}
        onKeyDown={onHeightKeyDown}
      />

      <header className={styles.header}>
        <div
          className={styles.panelToggles}
          role={tabbed ? 'tablist' : 'group'}
          aria-label={tabbed ? 'Code panel' : 'Visible code panels'}
        >
          {PANELS.map((panel) => {
            const on = tabbed ? activeTab === panel.id : panels[panel.id]
            return (
              <Button
                key={panel.id}
                variant="secondary"
                size="xs"
                className={styles.panelToggle}
                pressed={tabbed ? undefined : on}
                role={tabbed ? 'tab' : undefined}
                aria-selected={tabbed ? on : undefined}
                tooltip={
                  tabbed
                    ? `Show the ${panel.label} panel`
                    : on
                      ? `Hide the ${panel.label} panel`
                      : `Show the ${panel.label} panel`
                }
                onClick={() =>
                  tabbed ? setCodeDockActiveTab(panel.id) : toggleCodeDockPanel(panel.id)
                }
                data-testid={`code-dock-toggle-${panel.id}`}
              >
                <CheckIcon size={10} className={styles.panelToggleMark} aria-hidden="true" />
                {panel.label}
              </Button>
            )
          })}
        </div>
        <Button
          variant="ghost"
          size="xs"
          tooltip="Open the Properties panel as a floating window"
          onClick={openFloatingProperties}
          data-testid="code-dock-open-properties"
        >
          Properties
        </Button>
      </header>

      {tabbed ? (
        <div className={styles.columns}>
          <CodeDockPanel
            id={activeTab}
            label={PANELS.find((p) => p.id === activeTab)?.label ?? activeTab}
            runtimeValidation={runtimeValidation}
            expanded={expanded === activeTab}
            onExpand={() => setExpanded(activeTab)}
          />
        </div>
      ) : visiblePanels.length > 0 ? (
        <div className={styles.columns}>
          {visiblePanels.map((panel, index) => (
            <div key={panel.id} className={cn(styles.columnGroup, styles[`columnGroup_${panel.id}`])}>
              {index > 0 && (
                <div
                  className={styles.columnDivider}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${visiblePanels[index - 1].label} / ${panel.label} columns`}
                  onPointerDown={(event) =>
                    onDividerPointerDown(event, visiblePanels[index - 1].id, panel.id)
                  }
                />
              )}
              <CodeDockPanel
                id={panel.id}
                label={panel.label}
                runtimeValidation={runtimeValidation}
                expanded={expanded === panel.id}
                onExpand={() => setExpanded(panel.id)}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.allHidden}>All panels hidden — use the buttons above to show one.</div>
      )}

      {expanded ? (
        <Dialog
          open
          size="full"
          title={`${PANELS.find((p) => p.id === expanded)?.label ?? expanded} panel`}
          bodyClassName={styles.expandedBody}
          onClose={() => setExpanded(null)}
          ariaLabel="Expanded code panel"
        >
          <CodeDockPanelBody id={expanded} runtimeValidation={runtimeValidation} />
        </Dialog>
      ) : null}
    </section>
  )
}

function CodeDockPanelBody({ id, runtimeValidation }: CodeDockProps & { id: CodeDockPanelId }) {
  if (id === 'html') return <HtmlPanel />
  if (id === 'css') return <CssPanel />
  return <JsPanel runtimeValidation={runtimeValidation} />
}

function CodeDockPanel({
  id,
  label,
  runtimeValidation,
  expanded,
  onExpand,
}: CodeDockProps & { id: CodeDockPanelId; label: string; expanded: boolean; onExpand: () => void }) {
  return (
    <section
      className={styles.column}
      aria-label={`${label} panel`}
      data-testid={`code-dock-panel-${id}`}
    >
      <div className={styles.columnTitle}>
        {label}
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Expand the ${label} panel`}
          tooltip={`Expand the ${label} panel into a larger editor`}
          onClick={onExpand}
          data-testid={`code-dock-expand-${id}`}
        >
          <ArrowsScaleIcon size={12} aria-hidden="true" />
        </Button>
      </div>
      {expanded ? (
        <div className={styles.expandedPlaceholder}>Editing in the expanded view</div>
      ) : (
        <CodeDockPanelBody id={id} runtimeValidation={runtimeValidation} />
      )}
    </section>
  )
}
