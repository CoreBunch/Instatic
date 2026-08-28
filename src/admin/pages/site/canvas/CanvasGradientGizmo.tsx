/**
 * CanvasGradientGizmo — direct-manipulation gradient editing on the canvas.
 *
 * While a gradient-capable colour picker popover is open (`gradientPickerOpen`
 * in the store) and the selected element's fill is a gradient, this draws the
 * CSS gradient LINE across it with one handle per colour stop, so the gradient
 * can be aimed and its stops slid where the user is actually looking — instead
 * of typing degrees into a sidebar field and guessing. Closing the picker
 * hides the gizmo: it is an editing affordance, not permanent decoration.
 *
 *   - drag a STOP handle  → slides that stop (0–1 along the line)
 *   - drag an END cap     → rotates the gradient (Shift snaps to 15°)
 *   - drag the AXIS       → rotates too, so the whole line is a grip
 *   - double-click the AXIS → adds a stop there, in the gradient's own colour
 *
 * Radial gradients have no direction, so their end caps are inert; the stop
 * handles still work, riding the horizontal radius CSS uses by default.
 *
 * Coordinates
 * ───────────
 * The element lives inside a zoom-transformed iframe, so every rect goes
 * through `createCanvasOverlayMeasureSession` (the shared path the selection
 * rings use) to reach canvas-overlay space. The gizmo is portaled next to the
 * rings for the same reason they are: it must escape the breakpoint
 * viewport's overflow without being scaled by the canvas zoom, so handles stay
 * a constant grab size at every zoom level.
 *
 * Writes
 * ──────
 * The target comes from `useActiveStyleTarget` — the same resolution the
 * Properties panel uses — so a drag lands on whatever the user is currently
 * editing (class rule, breakpoint/condition override, or inline styles) and
 * never silently writes somewhere else. Drags are optimistic like the picker:
 * the overlay tracks the pointer every frame through local state, while store
 * commits ride the shared `createEmitThrottle` window, each emission one patch.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@site/store/store'
import { useActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import {
  createEmitThrottle,
  formatColor,
  formatGradient,
  gradientColorAt,
  parseGradient,
  type Gradient,
} from '@ui/components/ColorPicker'
import { createCanvasOverlayMeasureSession } from './canvasOverlayGeometry'
import { CanvasNodeElementCache } from './canvasNodeLookup'
import {
  angleFromPoint,
  gradientAxis,
  normalizeAngle,
  posFromPoint,
  rotationCapPoint,
  snapAngle,
  stopPoint,
  type GizmoPoint,
  type GizmoRect,
  type GradientAxis,
} from './gradientGizmoGeometry'
import styles from './CanvasGradientGizmo.module.css'

interface UseCanvasGradientGizmoOptions {
  breakpointId: string
  iframeElement: HTMLIFrameElement | null
  canvasRoot: HTMLElement | null
  portalTarget: HTMLElement
  portalMode: 'scoped' | 'fixed'
  /** Only the frame the user is actually editing draws the gizmo. */
  active: boolean
}

type GizmoVars = CSSProperties & {
  '--gizmo-x'?: string
  '--gizmo-y'?: string
  '--gizmo-length'?: string
  '--gizmo-angle'?: string
  '--gizmo-stop'?: string
}

/** What is being dragged, if anything. */
type DragKind = { kind: 'stop'; index: number } | { kind: 'angle' } | null

/**
 * Same trailing-throttle window as the picker's `onChange`: the gizmo is
 * OPTIMISTIC too — its handles follow the pointer every frame via local
 * state, while the heavy store commit (CRDT op + full canvas repaint) runs
 * at most once per window.
 */
const EMIT_THROTTLE_MS = 64

export function useCanvasGradientGizmo({
  breakpointId,
  iframeElement,
  canvasRoot,
  portalTarget,
  portalMode,
  active,
}: UseCanvasGradientGizmoOptions) {
  const permissions = useEditorPermissions()
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const target = useActiveStyleTarget()

  const gradientPickerOpen = useEditorStore((s) => s.gradientPickerOpen)

  const [rect, setRect] = useState<GizmoRect | null>(null)
  const [drag, setDrag] = useState<DragKind>(null)
  // Optimistic drag state: while a handle is held, the overlay renders THIS
  // gradient at frame rate; the store only sees the throttled commits below.
  const [dragGradient, setDragGradient] = useState<Gradient | null>(null)
  const nodeCacheRef = useRef<CanvasNodeElementCache | null>(null)
  if (nodeCacheRef.current === null) nodeCacheRef.current = new CanvasNodeElementCache()

  const committedGradient = target ? parseGradient(String(target.styles.backgroundImage ?? '')) : null
  const gradient = dragGradient ?? committedGradient
  // Only the frame being edited draws the gizmo — and only while a
  // gradient-capable picker popover is open: the gizmo is an editing
  // affordance, not a permanent decoration on every gradient-filled element.
  const show =
    active &&
    permissions.canEditStyle &&
    gradientPickerOpen &&
    gradient !== null &&
    selectedNodeId !== null &&
    activeBreakpointId === breakpointId

  // Track the element's rect on every frame, like the selection rings — the
  // gizmo has to follow zoom, pan, scroll and layout shifts, and there is no
  // single observer that covers all four.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!show || !iframeElement || !selectedNodeId) {
      setRect(null)
      return
    }
    const cache = nodeCacheRef.current
    let frame = 0
    const tick = () => {
      const session = createCanvasOverlayMeasureSession(iframeElement, canvasRoot)
      const iframeDoc = iframeElement.contentDocument
      const element = iframeDoc ? (cache?.resolve(iframeDoc, selectedNodeId) ?? null) : null
      const measured = session.measure(element)
      setRect((current) => (sameRect(current, measured) ? current : measured))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [show, iframeElement, canvasRoot, selectedNodeId])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!show || !rect || !gradient || !target) return null

  const axis = gradientAxis(rect, gradient.kind === 'radial' ? 90 : gradient.angle)

  /** Map a pointer/mouse event into the same overlay space the axis lives in. */
  function toOverlayPoint(event: { clientX: number; clientY: number }) {
    if (portalMode === 'fixed' || !canvasRoot) {
      return { x: event.clientX, y: event.clientY }
    }
    const canvasRect = canvasRoot.getBoundingClientRect()
    return {
      x: event.clientX - canvasRect.left + canvasRoot.scrollLeft,
      y: event.clientY - canvasRect.top + canvasRoot.scrollTop,
    }
  }

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>, kind: NonNullable<DragKind>) {
    event.preventDefault()
    event.stopPropagation()
    setDrag(kind)
    // Pointer capture keeps the move stream flowing to THIS handle even when
    // the pointer crosses the canvas iframe — without it the iframe swallows
    // pointermove and the drag freezes the moment the cursor leaves the
    // handle. Same mechanism the picker's sliders use.
    const handleEl = event.currentTarget
    handleEl.setPointerCapture(event.pointerId)

    // Rotation is RELATIVE to where the grab landed. Reading the absolute
    // centre→pointer angle every frame is only right for the end cap, which
    // sits on the axis's forward extension; grabbing the axis anywhere on its
    // start half points the opposite way and would snap the gradient 180°
    // round on the first move, and grabbing near the centre gives sub-pixel
    // leverage where a single pixel swings tens of degrees. Holding the
    // offset from the down point keeps the gradient still until the pointer
    // actually travels. The cap's offset comes out ~0, so both grips share
    // this one path.
    const angleOffset =
      kind.kind === 'angle' ? gradient!.angle - angleFromPoint(axis.center, toOverlayPoint(event)) : 0

    // Two throttles, matching the picker's optimistic split: the local
    // overlay updates once per animation frame; the heavy store commit is
    // time-throttled on top, and the final value always lands via flush().
    const emitThrottle = createEmitThrottle(EMIT_THROTTLE_MS, (css) => {
      target!.writeStyles({ backgroundImage: css })
    })
    let pending: PointerEvent | null = null
    let raf = 0
    const flush = () => {
      raf = 0
      if (!pending) return
      const point = toOverlayPoint(pending)
      pending = null
      let next: Gradient
      if (kind.kind === 'angle') {
        const raw = angleFromPoint(axis.center, point) + angleOffset
        next = {
          ...gradient!,
          angle: shiftHeld ? snapAngle(raw) : normalizeAngle(Math.round(raw)),
        }
      } else {
        const pos = posFromPoint(axis, point)
        next = {
          ...gradient!,
          stops: gradient!.stops.map((stop, index) =>
            index === kind.index ? { ...stop, pos } : stop,
          ),
        }
      }
      setDragGradient(next)
      emitThrottle.push(formatGradient(next, 'hex'))
    }
    let shiftHeld = event.shiftKey
    const handleMove = (move: PointerEvent) => {
      shiftHeld = move.shiftKey
      pending = move
      if (!raf) raf = requestAnimationFrame(flush)
    }
    const handleEnd = () => {
      handleEl.removeEventListener('pointermove', handleMove)
      handleEl.removeEventListener('pointerup', handleEnd)
      handleEl.removeEventListener('pointercancel', handleEnd)
      if (raf) cancelAnimationFrame(raf)
      flush()
      // The store write is synchronous, so the committed gradient replaces
      // the optimistic one in the same render — no flicker on release.
      emitThrottle.flush()
      setDragGradient(null)
      setDrag(null)
    }
    handleEl.addEventListener('pointermove', handleMove)
    handleEl.addEventListener('pointerup', handleEnd)
    handleEl.addEventListener('pointercancel', handleEnd)
  }

  /**
   * Double-click on the axis mints a stop where the pointer landed, taking the
   * colour the gradient already shows at that position — so the click adds a
   * handle without altering how the fill looks. Same bargain the picker's
   * strip makes when it is clicked away from an existing stop. Mouse only:
   * beginDrag preventDefaults the pointerdown, which suppresses the synthetic
   * click/dblclick pair for touch, so a double-tap does not reach here.
   */
  function addStopAtPointer(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    const pos = posFromPoint(axis, toOverlayPoint(event))
    const next: Gradient = {
      ...gradient!,
      stops: [...gradient!.stops, { color: gradientColorAt(gradient!.stops, pos), pos }],
    }
    target!.writeStyles({ backgroundImage: formatGradient(next, 'hex') })
  }

  const rotatable = gradient.kind !== 'radial'
  // Past the axis end, clear of the 100% stop handle — see rotationCapPoint.
  const capPoint = rotationCapPoint(axis, 18)

  // While a handle is held the badge names the value being set, because the
  // handle is under the cursor and the sidebar field is not where the user is
  // looking. It rides the same --gizmo-x/--gizmo-y contract as the handles,
  // and is hidden from assistive tech: the handles are already sliders with a
  // live aria-valuenow, so announcing the badge too would both duplicate them
  // and queue up one utterance per throttled frame.
  let badgeText: string | null = null
  let badgePoint: GizmoPoint | null = null
  if (drag?.kind === 'angle') {
    badgeText = `${Math.round(gradient.angle)}°`
    badgePoint = capPoint
  } else if (drag?.kind === 'stop') {
    const dragged = gradient.stops[drag.index]
    if (dragged) {
      badgeText = `${Math.round(dragged.pos * 100)}%`
      badgePoint = stopPoint(axis, dragged.pos)
    }
  }

  const overlay = (
    <div
      className={styles.gizmo}
      data-mode={portalMode}
      data-dragging={drag ? 'true' : undefined}
      data-drag-kind={drag?.kind}
      data-rotatable={rotatable ? 'true' : undefined}
      data-testid="canvas-gradient-gizmo"
      // Contract with ColorInput's outside-close: pressing a gizmo handle
      // must not dismiss the picker popover the gizmo belongs to.
      data-color-picker-keep-open="true"
      // The gizmo is portaled into the canvas root, whose onClick clears the
      // selection on background clicks — and React routes events up the
      // COMPONENT tree, not the DOM tree, so a portal's clicks arrive there
      // anyway. beginDrag only stops `pointerdown`; the `click` that follows
      // pointerup is a separate event, and without this guard it would clear
      // the selection and unmount the picker the gizmo belongs to at the end
      // of every drag. Same pattern as BreakpointSelectionOverlay's toolbar.
      onClick={(event) => event.stopPropagation()}
    >
      {/* Mounted only for the duration of a drag — see .dragShield. */}
      {drag !== null && <div className={styles.dragShield} aria-hidden="true" />}

      <div
        className={styles.axis}
        style={
          {
            '--gizmo-x': `${axis.start.x}px`,
            '--gizmo-y': `${axis.start.y}px`,
            '--gizmo-length': `${axis.length}px`,
            '--gizmo-angle': `${axisRotation(axis)}deg`,
          } as GizmoVars
        }
        onPointerDown={rotatable ? (event) => beginDrag(event, { kind: 'angle' }) : undefined}
        onDoubleClick={addStopAtPointer}
        aria-hidden="true"
      />

      {rotatable && (
        <div
          className={styles.endCap}
          style={{ '--gizmo-x': `${capPoint.x}px`, '--gizmo-y': `${capPoint.y}px` } as GizmoVars}
          role="slider"
          tabIndex={-1}
          aria-label="Gradient angle"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(gradient.angle)}
          onPointerDown={(event) => beginDrag(event, { kind: 'angle' })}
        />
      )}

      {gradient.stops.map((stop, index) => {
        const point = stopPoint(axis, stop.pos)
        return (
          <div
            key={index}
            className={styles.stopHandle}
            style={
              {
                '--gizmo-x': `${point.x}px`,
                '--gizmo-y': `${point.y}px`,
                '--gizmo-stop': formatColor(stop.color, 'hex'),
              } as GizmoVars
            }
            role="slider"
            tabIndex={-1}
            aria-label={`Gradient stop ${index + 1}`}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={Number(stop.pos.toFixed(2))}
            onPointerDown={(event) => beginDrag(event, { kind: 'stop', index })}
          />
        )
      })}

      {badgeText !== null && badgePoint !== null && (
        <div
          className={styles.badge}
          style={
            { '--gizmo-x': `${badgePoint.x}px`, '--gizmo-y': `${badgePoint.y}px` } as GizmoVars
          }
          aria-hidden="true"
        >
          {badgeText}
        </div>
      )}
    </div>
  )

  return createPortal(overlay, portalTarget)
}

/** Rotation of the axis line, in degrees clockwise from "pointing right". */
function axisRotation(axis: GradientAxis): number {
  return (Math.atan2(axis.end.y - axis.start.y, axis.end.x - axis.start.x) * 180) / Math.PI
}

function sameRect(a: GizmoRect | null, b: GizmoRect | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
