/**
 * CanvasModeToggle — Design / Live switch + the "Run scripts" control for the
 * canvas surface.
 *
 * - Design mode: the multi-breakpoint editing canvas (pan/zoom, every frame
 *   side-by-side).
 * - Live mode: a single real-size editable frame that scrolls normally (see
 *   CanvasLiveSurface). When live is active this toggle also surfaces a row of
 *   breakpoint icon buttons inline so the author can clamp the frame width to a
 *   device without leaving the canvas chrome.
 *
 * Both modes render the editable node tree. The "Run scripts" toggle is
 * orthogonal: it injects the site's bundled runtime scripts into the editable
 * iframes (both modes), so authored behaviour runs in-place while editing. Its
 * build status + a manual Refresh live next to the toggle — Refresh re-runs the
 * scripts after edits that React reconciled away.
 */
import type { SyntheticEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import type { Breakpoint } from '@core/page-tree'
import type { RuntimeScriptStatus } from './useRuntimeScriptBuild'
import { CursorMinimalSolidIcon } from 'pixel-art-icons/icons/cursor-minimal-solid'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { SmartphoneSolidIcon } from 'pixel-art-icons/icons/smartphone-solid'
import { TabletSolidIcon } from 'pixel-art-icons/icons/tablet-solid'
import { MonitorSolidIcon } from 'pixel-art-icons/icons/monitor-solid'
import { LaptopSolidIcon } from 'pixel-art-icons/icons/laptop-solid'
import { TvSolidIcon } from 'pixel-art-icons/icons/tv-solid'
import { cn } from '@ui/cn'
import type { PreviewScale } from './CanvasLiveSurface'
import { Select } from '@ui/components/Select'
import { Tooltip } from '@ui/components/Tooltip'
import styles from './CanvasModeToggle.module.css'

const SCALE_OPTIONS = [
  { value: 'fit', label: 'Fit' },
  ...[0.25, 0.5, 0.75, 1].map(value => ({ value, label: value * 100 + '%' })),
]

const EMPTY_BREAKPOINTS: Breakpoint[] = []

interface CanvasModeToggleProps {
  /** Build status of the runtime scripts (idle while the toggle is off). */
  scriptStatus: RuntimeScriptStatus
  /** Force a rebuild + re-run of the runtime scripts. */
  onRefreshScripts: () => void
  /**
   * Auto-hide the switcher until hovered/focused, rolling it down from the top
   * edge. Used in live mode, where the frame is flush with the top of the
   * surface and a pinned switcher would overlay the page's header. A slim
   * handle stays visible as the hover affordance. Mirrors `CanvasNotch`'s peek.
   */
  scaleControl?: { value: PreviewScale; onChange: (scale: PreviewScale) => void }
  peek?: boolean
}

export function CanvasModeToggle({ scriptStatus, onRefreshScripts, scaleControl, peek = false }: CanvasModeToggleProps) {
  const view = useEditorStore((s) => s.canvasView)
  const setView = useEditorStore((s) => s.setCanvasView)
  const breakpoints = useEditorStore((s) => s.site?.breakpoints ?? EMPTY_BREAKPOINTS)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const runScripts = useEditorStore((s) => s.runScripts)
  const setRunScripts = useEditorStore((s) => s.setRunScripts)

  // The toggle lives inside the canvas surface, which has its own click /
  // keyboard handlers (deselect, shortcuts, etc.). Stop propagation so the
  // buttons feel like chrome, not "clicks on empty canvas".
  const stopCanvasInteraction = (event: SyntheticEvent) => {
    event.stopPropagation()
  }

  return (
    <div className={cn(styles.shell, peek && styles.shellPeek)}>
      {peek && <div aria-hidden="true" className={styles.peekHandle} />}
      <div className={styles.roller}>
        <div
          className={styles.pill}
          role="toolbar"
          aria-label="Canvas mode"
          data-testid="canvas-mode-toggle"
          data-canvas-mode-pill=""
          onClick={stopCanvasInteraction}
        >
      {!scaleControl && <>
      <div role="tablist" aria-label="Canvas view" className={styles.tablist}>
        <Tooltip content="Design mode (multi-breakpoint canvas)">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'design'}
            aria-label="Design"
            data-testid="canvas-mode-toggle-design"
            className={cn(styles.tab, view === 'design' && styles.tabActive)}
            onClick={() => setView('design')}
          >
            <CursorMinimalSolidIcon size={14} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip content="Live mode (single real-size editable frame)">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'live'}
            aria-label="Live"
            data-testid="canvas-mode-toggle-live"
            className={cn(styles.tab, view === 'live' && styles.tabActive)}
            onClick={() => setView('live')}
          >
            <EyeSolidIcon size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      {/* Run scripts toggle — injects the site's bundled runtime scripts into
          the editable frames so authored behaviour runs while editing. */}
      <span className={styles.divider} aria-hidden="true" />
      <Tooltip content="Run site scripts inside the editable frames">
        <button
          type="button"
          aria-pressed={runScripts}
          aria-label="Run scripts"
          data-testid="canvas-run-scripts-toggle"
          className={cn(styles.tab, runScripts && styles.tabActive)}
          data-script-status={runScripts ? scriptStatus : undefined}
          onClick={() => setRunScripts(!runScripts)}
        >
          <CodeIcon size={14} aria-hidden="true" />
        </button>
      </Tooltip>
      {runScripts && (
        <Tooltip content="Re-run scripts from current site state">
          <button
            type="button"
            aria-label="Refresh scripts"
            data-testid="canvas-run-scripts-refresh"
            className={styles.tab}
            disabled={scriptStatus === 'building'}
            onClick={() => onRefreshScripts()}
          >
            <ReloadIcon size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      )}

      {/* Breakpoint switcher — only in live mode. Design mode keeps its own
          breakpoint context selector elsewhere on the canvas chrome. */}
      </>}
      {(scaleControl || view === 'live') && breakpoints.length > 0 && (
        <>
          {!scaleControl && <span className={styles.divider} aria-hidden="true" />}
          <div
            role="radiogroup"
            aria-label="Live frame width"
            className={styles.breakpointGroup}
            data-testid="canvas-live-breakpoints"
          >
            {breakpoints.map((breakpoint) => {
              const active = breakpoint.id === activeBreakpointId
              return (
                <Tooltip
                  key={breakpoint.id}
                  content={`${breakpoint.label} · ${breakpoint.width}px`}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={`Frame width: ${breakpoint.label} (${breakpoint.width}px)`}
                    data-testid={`canvas-live-breakpoint-${breakpoint.id}`}
                    className={cn(styles.tab, active && styles.tabActive)}
                    onClick={() => setActiveBreakpoint(breakpoint.id)}
                  >
                    <BreakpointIcon name={breakpoint.icon} />
                  </button>
                </Tooltip>
              )
            })}
          </div>
          {scaleControl && (
            <>
              <span className={styles.divider} aria-hidden="true" />
              <Select aria-label="Preview scale" fieldSize="xs" value={scaleControl.value}
                className={styles.scaleSelect} options={SCALE_OPTIONS} menuMinWidth={96}
                onChange={event => {
                  const option = SCALE_OPTIONS.find(item => String(item.value) === event.target.value)
                  if (option) scaleControl.onChange(typeof option.value === 'number' ? option.value : 'fit')
                }} />
            </>
          )}
        </>
      )}
        </div>
      </div>
    </div>
  )
}

function BreakpointIcon({ name }: { name: string }) {
  switch (name) {
    case 'smartphone':
      return <SmartphoneSolidIcon size={14} aria-hidden="true" />
    case 'tablet':
      return <TabletSolidIcon size={14} aria-hidden="true" />
    case 'laptop':
      return <LaptopSolidIcon size={14} aria-hidden="true" />
    case 'tv':
      return <TvSolidIcon size={14} aria-hidden="true" />
    case 'monitor':
    default:
      return <MonitorSolidIcon size={14} aria-hidden="true" />
  }
}
