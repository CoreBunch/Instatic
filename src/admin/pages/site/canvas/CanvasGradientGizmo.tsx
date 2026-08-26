/**
 * CanvasGradientGizmo — direct-manipulation gradient editing on the canvas.
 *
 * When the selected element's fill is a gradient, this draws the CSS gradient
 * LINE across it with one handle per colour stop, so the gradient can be aimed
 * and its stops slid where the user is actually looking — instead of typing
 * degrees into a sidebar field and guessing.
 *
 *   - drag a STOP handle  → slides that stop (0–1 along the line)
 *   - drag an END cap     → rotates the gradient (Shift snaps to 15°)
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
 * never silently writes somewhere else. Drags are frame-throttled and each
 * emission is one patch, matching the picker's behaviour.
 */

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@site/store/store'
import { useActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { formatColor, formatGradient, parseGradient, type Gradient } from '@ui/components/ColorPicker'
import { createCanvasOverlayMeasureSession } from './canvasOverlayGeometry'
import { CanvasNodeElementCache } from './canvasNodeLookup'
import {
  angleFromPoint,
  gradientAxis,
  posFromPoint,
  snapAngle,
  stopPoint,
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

  const [rect, setRect] = useState<GizmoRect | null>(null)
  const [drag, setDrag] = useState<DragKind>(null)
  const nodeCacheRef = useRef<CanvasNodeElementCache | null>(null)
  if (nodeCacheRef.current === null) nodeCacheRef.current = new CanvasNodeElementCache()

  const gradient = target ? parseGradient(String(target.styles.backgroundImage ?? '')) : null
  // Only the frame being edited draws the gizmo: a second copy on every
  // breakpoint preview would be noise, and its drags would target this same
  // rule anyway.
  const show =
    active &&
    permissions.canEditStyle &&
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

  /** Map a pointer event into the same overlay space the axis lives in. */
  function toOverlayPoint(event: PointerEvent | ReactPointerEvent) {
    if (portalMode === 'fixed' || !canvasRoot) {
      return { x: event.clientX, y: event.clientY }
    }
    const canvasRect = canvasRoot.getBoundingClientRect()
    return {
      x: event.clientX - canvasRect.left + canvasRoot.scrollLeft,
      y: event.clientY - canvasRect.top + canvasRoot.scrollTop,
    }
  }

  function commit(next: Gradient) {
    target!.writeStyles({ backgroundImage: formatGradient(next, 'hex') })
  }

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>, kind: NonNullable<DragKind>) {
    event.preventDefault()
    event.stopPropagation()
    setDrag(kind)
    // Frame-throttled: a drag frame costs a store commit + CRDT op + canvas
    // repaint, so anything above the display rate is wasted work.
    let pending: PointerEvent | null = null
    let raf = 0
    const flush = () => {
      raf = 0
      if (!pending) return
      const point = toOverlayPoint(pending)
      pending = null
      if (kind.kind === 'angle') {
        const raw = angleFromPoint(axis.center, point)
        commit({ ...gradient!, angle: shiftHeld ? snapAngle(raw) : Math.round(raw) })
        return
      }
      const pos = posFromPoint(axis, point)
      commit({
        ...gradient!,
        stops: gradient!.stops.map((stop, index) =>
          index === kind.index ? { ...stop, pos } : stop,
        ),
      })
    }
    let shiftHeld = event.shiftKey
    const handleMove = (move: PointerEvent) => {
      shiftHeld = move.shiftKey
      pending = move
      if (!raf) raf = requestAnimationFrame(flush)
    }
    const handleEnd = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      if (raf) cancelAnimationFrame(raf)
      flush()
      setDrag(null)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
  }

  const rotatable = gradient.kind !== 'radial'
  const overlay = (
    <div
      className={styles.gizmo}
      data-mode={portalMode}
      data-dragging={drag ? 'true' : undefined}
      data-testid="canvas-gradient-gizmo"
    >
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
        aria-hidden="true"
      />

      {rotatable && (
        <div
          className={styles.endCap}
          style={{ '--gizmo-x': `${axis.end.x}px`, '--gizmo-y': `${axis.end.y}px` } as GizmoVars}
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
