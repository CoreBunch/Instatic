import { generateFrameworkColorVariableSets } from '@core/framework'
import { gradientLayer } from '@site/property-controls/gradientLayer'
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
 * Radial and conic stops use different geometry and are edited in the picker.
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
 * never silently writes somewhere else. Drags use the transient canvas preview until pointer release.
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
import type { ActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import {
  formatColor,
  formatGradient,
  gradientColorAt,
  parseGradient,
  type Gradient,
} from '@ui/components/ColorPicker'
import { useCanvasStyleGesture } from './canvasStyleGesture'
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
  target: ActiveStyleTarget
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

export function CanvasGradientGizmo({
  breakpointId,
  iframeElement,
  canvasRoot,
  portalTarget,
  portalMode,
  active,
  target,
}: UseCanvasGradientGizmoOptions) {
  const permissions = useEditorPermissions()
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)


  const [rect, setRect] = useState<GizmoRect | null>(null)
  const [drag, setDrag] = useState<DragKind>(null)
  // Keep stop identity stable while a drag crosses another stop.
  const [dragGradient, setDragGradient] = useState<Gradient | null>(null)
  const nodeCacheRef = useRef<CanvasNodeElementCache | null>(null)
  if (nodeCacheRef.current === null) nodeCacheRef.current = new CanvasNodeElementCache()

  const colors = useEditorStore((s) => s.site?.settings.framework?.colors)
  const layer = gradientLayer(target.styles.backgroundImage)
  const committedGradient = active && layer.value ? parseGradient(layer.value, generateFrameworkColorVariableSets(colors).light) : null
  const gradient = dragGradient ?? committedGradient
  // Only the frame being edited draws the gizmo — and only while a
  // gradient-capable picker popover is open: the gizmo is an editing
  // affordance, not a permanent decoration on every gradient-filled element.
  const show =
    active &&
    permissions.canEditStyle &&
    gradient?.kind === 'linear' &&
    selectedNodeId !== null &&
    activeBreakpointId === breakpointId

  const capture = useCanvasStyleGesture(show ? target.key : undefined)

  // Track the element's rect on every frame, like the selection rings — the
  // gizmo has to follow zoom, pan, scroll and layout shifts, and there is no
  // single observer that covers all four.
  useEffect(() => {
    if (!show || !iframeElement || !selectedNodeId) return
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

  if (!show || !iframeElement || !rect || !gradient) return null

  const axis = gradientAxis(rect, gradient.angle)

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

    let last: string | null = null
    const clear = () => {
      target.clearPreview()
      setDragGradient(null)
      setDrag(null)
    }
    capture(event, {
      move(move) {
        const point = toOverlayPoint(move)
        const raw = angleFromPoint(axis.center, point) + angleOffset
        const next: Gradient = kind.kind === 'angle'
          ? { ...gradient!, angle: move.shiftKey ? snapAngle(raw) : normalizeAngle(Math.round(raw)) }
          : { ...gradient!, stops: gradient!.stops.map((stop, index) =>
              index === kind.index ? { ...stop, pos: posFromPoint(axis, point) } : stop) }
        const css = layer.replace(formatGradient(next, 'hex'))
        if (css === last) return
        last = css
        setDrag(kind)
        setDragGradient(next)
        target.previewStyles({ backgroundImage: css })
      },
      end() {
        if (last !== null) target.writeStyles({ backgroundImage: last })
        clear()
      },
      cancel: clear,
    })
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
    target.writeStyles({ backgroundImage: layer.replace(formatGradient(next, 'hex')) })
  }

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
        onPointerDown={(event) => beginDrag(event, { kind: 'angle' })}
        onDoubleClick={addStopAtPointer}
        aria-hidden="true"
      />

      <div
        className={styles.endCap}
        style={{ '--gizmo-x': `${capPoint.x}px`, '--gizmo-y': `${capPoint.y}px` } as GizmoVars}
        role="slider"
        tabIndex={0}
        aria-label="Gradient angle"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(gradient.angle)}
        onPointerDown={(event) => beginDrag(event, { kind: 'angle' })}
        onKeyDown={(event) => {
          const next = sliderKeyValue(event.key, gradient.angle, event.shiftKey ? 15 : 1, 360)
          if (next === null) return
          event.preventDefault()
          event.stopPropagation()
          target.writeStyles({ backgroundImage: layer.replace(formatGradient({ ...gradient, angle: next }, 'hex')) })
        }}
      />

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
            tabIndex={0}
            aria-label={`Gradient stop ${index + 1}`}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={Number(stop.pos.toFixed(2))}
            onPointerDown={(event) => beginDrag(event, { kind: 'stop', index })}
            onKeyDown={(event) => {
              const pos = sliderKeyValue(event.key, stop.pos, event.shiftKey ? 0.1 : 0.01, 1)
              if (pos === null) return
              event.preventDefault()
              event.stopPropagation()
              const stops = gradient.stops.map((item, i) => i === index ? { ...item, pos } : item)
              target.writeStyles({ backgroundImage: layer.replace(formatGradient({ ...gradient, stops }, 'hex')) })
            }}
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

function sliderKeyValue(key: string, current: number, step: number, max: number) {
  switch (key) {
    case 'Home': return 0
    case 'End': return max
    case 'ArrowRight':
    case 'ArrowUp': return Math.min(max, current + step)
    case 'ArrowLeft':
    case 'ArrowDown': return Math.max(0, current - step)
    default: return null
  }
}

/** Rotation of the axis line, in degrees clockwise from "pointing right". */
function axisRotation(axis: GradientAxis): number {
  return (Math.atan2(axis.end.y - axis.start.y, axis.end.x - axis.start.x) * 180) / Math.PI
}

function sameRect(a: GizmoRect | null, b: GizmoRect | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
