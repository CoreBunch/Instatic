/**
 * BreakpointFrame — a fixed-width design-mode viewport for one breakpoint.
 *
 * Renders the page tree inside a frame sized to the breakpoint's width.
 * One BreakpointFrame is rendered per breakpoint, positioned side-by-side
 * inside CanvasTransformLayer (so they're panned/zoomed together).
 *
 * The viewport itself is an iframe (see `IframeFrameSurface`) so the
 * canvas DOM matches the published HTML exactly — `body` is the page body,
 * not the editor chrome. See `docs/features/canvas-iframe-per-frame.md`
 * for the rationale.
 *
 * BreakpointFrame is the design-canvas frame (one per breakpoint, panned and
 * zoomed together). Live mode renders a single real-size frame in its own
 * surface (CanvasLiveSurface) using the same `IframeFrameSurface` with
 * `interaction="live"`. Both can run the site's runtime scripts when the
 * "Run scripts" toggle is on — see `runtimeScripts`.
 */

import { useRef, useState, type CSSProperties } from 'react'
import type { Page, Breakpoint } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { CanvasComposedTree } from './CanvasComposedTree'
import { BreakpointSelectionOverlay } from './BreakpointSelectionOverlay'
import { CanvasBreakpointContext, CanvasTemplateContext } from './CanvasContexts'
import { IframeFrameSurface, type IframeFrameSurfaceHandle } from './IframeFrameSurface'
import type { InjectableRuntimeScript } from './useRuntimeScriptBuild'
import { Button } from '@ui/components/Button'
import { CursorTooltip, type CursorTooltipPoint } from '@ui/components/Tooltip'
import { ArrowsScaleIcon } from 'pixel-art-icons/icons/arrows-scale'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { EyeOffSolidIcon } from 'pixel-art-icons/icons/eye-off-solid'
import { cn } from '@ui/cn'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { useEditorStore } from '@site/store/store'
import { clientPointToEditorDoc } from './canvasDomGeometry'
import { closestReadonlyRegion } from './readonlyRegion'
import styles from './BreakpointFrame.module.css'

interface BreakpointFrameProps {
  page: Page
  breakpoint: Breakpoint
  isActive: boolean
  isDimmed?: boolean
  activationHintEnabled?: boolean
  onActivate: (breakpointId: string) => void
  templateContext?: TemplateRenderDataContext
  /** Opt-in runtime scripts injected into this frame; empty/undefined = none. */
  runtimeScripts?: InjectableRuntimeScript[]
}

export function BreakpointFrame({
  page,
  breakpoint,
  isActive,
  isDimmed = false,
  activationHintEnabled = false,
  onActivate,
  templateContext,
  runtimeScripts,
}: BreakpointFrameProps) {
  // --bp-width drives both label width and viewport width via CSS (dynamic value)
  const bpStyle = { '--bp-width': `${breakpoint.width}px` } as CSSProperties

  // Outer viewport `<div>` wrapping the iframe. The selection overlay still
  // measures the viewport (not the iframe) for zoom/pan/toolbar positioning;
  // the iframe handle below is just for translating *inside-iframe* element
  // rects into editor coordinates.
  const viewportRef = useRef<HTMLDivElement | null>(null)
  // Handle to the iframe surface; the selection overlay reads the iframe
  // element so it can translate inside-iframe element rects into editor
  // viewport coordinates.
  const iframeHandleRef = useRef<IframeFrameSurfaceHandle | null>(null)
  // Track the iframe element separately for the selection overlay's
  // `getBoundingClientRect()` call. State (not ref) so the overlay re-renders
  // when the iframe mounts.
  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null)
  const [activationHintPoint, setActivationHintPoint] = useState<CursorTooltipPoint | null>(null)
  const [readonlyHint, setReadonlyHint] = useState<{ text: string; point: CursorTooltipPoint } | null>(null)

  // Opening the source of a read-only composed region (template chrome,
  // inlined component, outlet preview) on double-click.
  const openPageInCanvas = useEditorStore((s) => s.openPageInCanvas)
  const setActiveDocument = useEditorStore((s) => s.setActiveDocument)

  // Per-frame chrome actions: open this breakpoint in live mode, and collapse
  // the frame to its slim header so not every breakpoint renders at once. The
  // collapsed set is ephemeral editor state (see canvasSlice).
  const setCanvasView = useEditorStore((s) => s.setCanvasView)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const toggleBreakpointCollapsed = useEditorStore((s) => s.toggleBreakpointCollapsed)
  const isCollapsed = useEditorStore((s) => s.collapsedBreakpointIds.includes(breakpoint.id))

  const handleOpenLive = () => {
    setActiveBreakpoint(breakpoint.id)
    setCanvasView('live')
  }
  const handleToggleCollapsed = () => toggleBreakpointCollapsed(breakpoint.id)
  const handleReadonlyOpen = (kind: 'page' | 'component', id: string) => {
    if (kind === 'component') {
      setActiveDocument({ kind: 'visualComponent', vcId: id })
    } else {
      openPageInCanvas(id)
    }
  }

  // Breakpoint chrome (active highlight + label-click-to-activate) is a style
  // editing affordance — picking the "active" breakpoint controls where per-
  // breakpoint style overrides land. Hidden for content-only Clients and
  // pure Viewers; they get plain frames without an active-state outline.
  const permissions = useEditorPermissions()
  const breakpointChromeVisible = permissions.canEditStyle || permissions.canEditStructure

  const handleIframeRef = (handle: IframeFrameSurfaceHandle | null) => {
    iframeHandleRef.current = handle
    setIframeEl(handle?.iframeElement ?? null)
  }

  const handleEmptyFrameClick = () => {
    if (!breakpointChromeVisible) return
    onActivate(breakpoint.id)
  }

  const inactiveFrameActivates = breakpointChromeVisible && activationHintEnabled && !isActive
  const handleFrameCursorMove = (event: MouseEvent) => {
    if (inactiveFrameActivates) {
      // The whole frame's "click to activate" affordance owns the cursor here;
      // don't compete with a read-only hint.
      setActivationHintPoint(clientPointToEditorDoc(event))
      return
    }
    // On the active frame, hovering read-only composed content (template
    // chrome, an inlined component, an outlet preview) shows a hint naming its
    // source. `closestReadonlyRegion` resolves the nearest boundary, so the
    // active page's editable content — spliced inside the template wrapper —
    // does NOT show the hint.
    const region = closestReadonlyRegion(event.target)
    const label = region?.getAttribute('data-instatic-readonly-label') ?? null
    setReadonlyHint(
      label ? { text: `Part of ${label} — double-click to edit`, point: clientPointToEditorDoc(event) } : null,
    )
  }

  const handleFrameCursorLeave = () => {
    setActivationHintPoint(null)
    setReadonlyHint(null)
  }

  return (
    <div
      className={cn(styles.frameWrapper, isDimmed && styles.frameWrapperDimmed)}
      data-breakpoint-dimmed={isDimmed ? 'true' : undefined}
      data-testid={`canvas-frame-${breakpoint.id}`}
      style={bpStyle}
    >
      {/* Frame chrome row — breakpoint label.
          Hidden for non-editors: the label button activates a per-breakpoint
          override target, which only makes sense when the caller can edit
          styles or structure. */}
      {breakpointChromeVisible && (
        <div className={styles.labelRow}>
          <Button
            variant="ghost"
            size="sm"
            pressed={isActive}
            onClick={() => onActivate(breakpoint.id)}
            className={styles.labelBtn}
            aria-label={`Switch to ${breakpoint.label} breakpoint`}
            data-testid={`canvas-frame-activate-${breakpoint.id}`}
            aria-pressed={isActive}
          >
            {breakpoint.label}
            <span className={styles.pxBadge}>{breakpoint.width}px</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={handleOpenLive}
            tooltip={`Open ${breakpoint.label} in live mode`}
            aria-label={`Open ${breakpoint.label} breakpoint in live mode`}
            data-testid={`canvas-frame-live-${breakpoint.id}`}
          >
            <ArrowsScaleIcon size={14} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            pressed={isCollapsed}
            onClick={handleToggleCollapsed}
            tooltip={isCollapsed ? `Show ${breakpoint.label} frame` : `Collapse ${breakpoint.label} frame`}
            aria-label={isCollapsed ? `Show ${breakpoint.label} frame` : `Collapse ${breakpoint.label} frame`}
            aria-pressed={isCollapsed}
            data-testid={`canvas-frame-collapse-${breakpoint.id}`}
          >
            {isCollapsed ? (
              <EyeOffSolidIcon size={14} aria-hidden="true" />
            ) : (
              <EyeSolidIcon size={14} aria-hidden="true" />
            )}
          </Button>
        </div>
      )}

      {/* Iframe viewport — see IframeFrameSurface for why this is an iframe
          instead of a plain `<div>`. The outer wrapper div is still here so
          the selection overlay has a positioning context and so the
          breakpoint's `data-breakpoint-id` is observable to canvas-level
          DOM tools that don't cross the iframe boundary.

          Collapsed: the slim label header above stays, but the heavy iframe is
          dropped entirely so this breakpoint isn't rendered alongside the
          others. */}
      {!isCollapsed && (
      <div
        ref={viewportRef}
        data-breakpoint-id={breakpoint.id}
        className={styles.viewport}
      >
        <IframeFrameSurface
          ref={handleIframeRef}
          breakpointId={breakpoint.id}
          width={breakpoint.width}
          onClick={handleEmptyFrameClick}
          onCursorMove={handleFrameCursorMove}
          onCursorLeave={handleFrameCursorLeave}
          onReadonlyOpen={handleReadonlyOpen}
          runtimeScripts={runtimeScripts}
        >
          <CanvasTemplateContext.Provider value={templateContext}>
            <CanvasBreakpointContext.Provider value={breakpoint.id}>
              <CanvasComposedTree page={page} />
            </CanvasBreakpointContext.Provider>
          </CanvasTemplateContext.Provider>
        </IframeFrameSurface>

        {/* Selection / hover rings — rendered in the parent document but
            positioned over the iframe. The overlay handles the iframe-rect
            → editor-viewport coordinate translation. */}
        <BreakpointSelectionOverlay
          breakpointId={breakpoint.id}
          viewportRef={viewportRef}
          iframeElement={iframeEl}
        />
        <CursorTooltip
          content={`Click to activate ${breakpoint.label} breakpoint`}
          point={inactiveFrameActivates ? activationHintPoint : null}
        />
        <CursorTooltip
          content={readonlyHint?.text ?? ''}
          point={readonlyHint ? readonlyHint.point : null}
        />
      </div>
      )}
    </div>
  )
}
