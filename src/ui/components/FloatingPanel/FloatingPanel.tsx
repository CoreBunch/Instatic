/**
 * FloatingPanel — the panel's detached piece (the redesign's `.popout`).
 *
 * A portalled, draggable panel that opens BESIDE its trigger. The properties
 * panel hangs on the right edge, so the panel opens to the LEFT (over the
 * canvas, not over the panel it came from) and falls back under the trigger
 * when there is no room. It carries the panel's own tone, lifted by a border
 * and a shadow rather than by a lighter fill — it is a piece of the panel
 * that floated off, not a foreign box (docs/features/inspector-panel.md §9).
 *
 * Owns everything a floating editor needs and no editor logic at all:
 * placement, viewport clamping, staying clear of the marked sidebars, the
 * drag header, the glide-back after a rubber-banded drop, and dismissal by ×,
 * Escape, or a pointerdown outside itself and its trigger — which is what
 * keeps at most one panel open at a time.
 *
 * Callers: the colour picker (ColorInput), and the inspector's effect / border
 * popouts. One implementation, so "the floating editor" behaves identically
 * wherever it appears.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import styles from './FloatingPanel.module.css'

/** Panel gap from the trigger, and the viewport margin it is clamped to. */
const PANEL_GAP = 8
const VIEWPORT_MARGIN = 8
const DEFAULT_WIDTH = 244
/** Height guess used for the first placement, before the panel is measured. */
const DEFAULT_HEIGHT = 470

/** Fraction of the into-obstacle overshoot the panel follows while dragged. */
const OBSTACLE_RESISTANCE = 0.25

type PanelStyle = CSSProperties & {
  '--floating-panel-x'?: string
  '--floating-panel-y'?: string
}

interface FloatingPanelProps {
  open: boolean
  onClose: () => void
  /** The control the panel opens beside; also excluded from outside-close. */
  anchorRef: RefObject<HTMLElement | null>
  /** Header text. Also the accessible name unless `ariaLabel` overrides it. */
  title: ReactNode
  ariaLabel?: string
  /** Accessible name of the × button — say WHAT closes, not just "Close". */
  closeLabel?: string
  children: ReactNode
  /** Rendered width; also the width used for the first placement. */
  width?: number
  /** Height guess for the first placement (re-measured immediately after). */
  estimatedHeight?: number
  /**
   * Extra surfaces whose pointerdown must NOT close the panel — companion
   * editing UI that belongs to it (e.g. the on-canvas gradient gizmo).
   */
  keepOpenSelector?: string
  className?: string
}

export function FloatingPanel({
  open,
  onClose,
  anchorRef,
  title,
  ariaLabel,
  closeLabel = 'Close',
  children,
  width = DEFAULT_WIDTH,
  estimatedHeight = DEFAULT_HEIGHT,
  keepOpenSelector,
  className,
}: FloatingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)

  // Place on open, forget on close, so re-opening always lands beside the
  // trigger rather than where the user last dragged it.
  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const panel = panelRef.current
    // Once the panel has rendered its real content its height is known — the
    // second pass re-clamps from the measurement instead of the guess, so it
    // opens fully on screen and clear of the sidebars.
    const measuredWidth = panel?.offsetWidth ?? width
    const measuredHeight = panel?.offsetHeight ?? estimatedHeight
    setPosition(
      avoidObstacles(
        placeBesideAnchor(rect, measuredWidth, measuredHeight),
        measuredWidth,
        measuredHeight,
      ),
    )
  }, [open, anchorRef, width, estimatedHeight])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Dismissal: Escape, or a pointerdown outside the panel and its trigger.
  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      if (
        keepOpenSelector &&
        target instanceof Element &&
        target.closest(keepOpenSelector)
      ) {
        return
      }
      onClose()
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
      // Focus goes back where it came from, or it lands on <body> and the
      // next Tab restarts from the top of the document.
      if (anchorRef.current instanceof HTMLElement) anchorRef.current.focus()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open, onClose, anchorRef, keepOpenSelector])

  /**
   * Header drag: window-level listeners (not pointer capture on the header)
   * so the panel keeps following even when the pointer moves fast.
   *
   * Performance: pointer moves write the anchor custom properties STRAIGHT
   * onto the element — zero React renders per move, so the panel sticks to
   * the cursor no matter how heavy its subtree is. React state is reconciled
   * once, at drag end.
   *
   * Boundary handling is soft: dragging past the viewport edge or INTO a
   * sidebar rubber-bands, and on release the panel glides back to the allowed
   * spot. That release is the ONLY moment it animates — `.gliding` is toggled
   * imperatively, armed at drop and stripped both when the glide ends and at
   * the start of the next drag, so grabbing the panel mid-glide still follows
   * the pointer 1:1. Keeping it off React state also means a freshly opened
   * panel can never inherit it and animate its open-time re-placement.
   */
  function beginPanelDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const panel = panelRef.current
    if (position === null || !panel) return
    // The × button lives in the header — don't let its press start a drag.
    if (event.target instanceof Element && event.target.closest('button')) return
    event.preventDefault()
    panel.classList.remove(styles.gliding)
    const offsetX = event.clientX - position.x
    const offsetY = event.clientY - position.y
    // Sizes and obstacle rects are stable for one drag — measure once.
    const panelWidth = panel.offsetWidth
    const panelHeight = panel.offsetHeight
    const obstacles = measureObstacles()
    let last = position

    const applyVars = (pos: { x: number; y: number }) => {
      panel.style.setProperty('--floating-panel-x', `${pos.x}px`)
      panel.style.setProperty('--floating-panel-y', `${pos.y}px`)
    }

    const handleMove = (move: PointerEvent) => {
      const raw = { x: move.clientX - offsetX, y: move.clientY - offsetY }
      const allowed = avoidObstacles(
        clampPosition(raw.x, raw.y, panelWidth, panelHeight),
        panelWidth,
        panelHeight,
        obstacles,
      )
      last = {
        x: allowed.x + (raw.x - allowed.x) * OBSTACLE_RESISTANCE,
        y: allowed.y + (raw.y - allowed.y) * OBSTACLE_RESISTANCE,
      }
      applyVars(last)
    }
    const handleEnd = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      const settled = avoidObstacles(
        clampPosition(last.x, last.y, panelWidth, panelHeight),
        panelWidth,
        panelHeight,
        obstacles,
      )
      // Only a rubber-banded release actually moves the panel, and the class
      // has to land before the anchors below or there is nothing to animate.
      if (settled.x !== last.x || settled.y !== last.y) panel.classList.add(styles.gliding)
      applyVars(settled)
      setPosition(settled)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
  }

  if (!open || position === null || typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
      className={cn(styles.panel, className)}
      // Transitions from the panel's own controls bubble up here, so only the
      // panel's own position transition disarms the glide.
      onTransitionEnd={(event) => {
        if (event.propertyName !== 'left' && event.propertyName !== 'top') return
        event.currentTarget.classList.remove(styles.gliding)
      }}
      style={
        {
          width: `${width}px`,
          '--floating-panel-x': `${position.x}px`,
          '--floating-panel-y': `${position.y}px`,
        } as PanelStyle
      }
    >
      <div className={styles.header} onPointerDown={beginPanelDrag}>
        <span className={styles.title}>{title}</span>
        <Button variant="ghost" size="xs" iconOnly aria-label={closeLabel} onClick={onClose}>
          <CloseIcon size={10} aria-hidden="true" />
        </Button>
      </div>
      {children}
    </div>,
    document.body,
  )
}

/**
 * Beside the trigger: to its LEFT, top-aligned (the panel then sits over the
 * canvas rather than over the properties panel, and clear of the marked
 * obstacles). Falls back to under the trigger when there is no room on the
 * left.
 */
function placeBesideAnchor(
  rect: DOMRect,
  width: number,
  height: number,
): { x: number; y: number } {
  const left = rect.left - width - PANEL_GAP
  if (left >= VIEWPORT_MARGIN) return clampPosition(left, rect.top, width, height)
  return clampPosition(rect.left, rect.bottom + PANEL_GAP, width, height)
}

function clampPosition(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const maxX = window.innerWidth - width - VIEWPORT_MARGIN
  const maxY = window.innerHeight - height - VIEWPORT_MARGIN
  return {
    x: Math.max(VIEWPORT_MARGIN, Math.min(x, maxX)),
    y: Math.max(VIEWPORT_MARGIN, Math.min(y, maxY)),
  }
}

/** Measure every `data-floating-obstacle` element's current rect. */
function measureObstacles(): DOMRect[] {
  const rects: DOMRect[] = []
  for (const element of document.querySelectorAll('[data-floating-obstacle]')) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) rects.push(rect)
  }
  return rects
}

/**
 * Keep the panel off elements marked `data-floating-obstacle` (the editor
 * marks its sidebars): when the panel intersects one, it is pushed
 * horizontally toward the canvas — left of a right-side obstacle, right of a
 * left-side one — then re-clamped to the viewport.
 */
function avoidObstacles(
  pos: { x: number; y: number },
  width: number,
  height: number,
  obstacles: readonly DOMRect[] = measureObstacles(),
): { x: number; y: number } {
  let { x } = pos
  const { y } = pos
  for (const rect of obstacles) {
    const intersects =
      x < rect.right && x + width > rect.left && y < rect.bottom && y + height > rect.top
    if (!intersects) continue
    x = rect.left + rect.width / 2 > window.innerWidth / 2
      ? rect.left - width - PANEL_GAP
      : rect.right + PANEL_GAP
  }
  return clampPosition(x, y, width, height)
}
