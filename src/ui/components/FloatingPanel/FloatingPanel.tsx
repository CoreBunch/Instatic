/**
 * FloatingPanel — the panel's detached piece (the redesign's `.popout`).
 *
 * A portalled, draggable panel that opens BESIDE its trigger. The properties
 * panel hangs on the right edge, so the panel opens to the LEFT (over the
 * canvas, not over the panel it came from) and falls back under the trigger
 * when there is no room. It carries the panel's own tone, lifted by a border
 * and a shadow rather than by a lighter fill — it is a piece of the panel
 * that floated off, not a foreign box (docs/features/inspector-panel.md §10).
 *
 * Owns everything a floating editor needs and no editor logic at all:
 * placement, viewport clamping (first from a size guess, then re-clamped from
 * the real measurement — and kept on screen by a ResizeObserver as the content
 * grows), staying clear of the marked sidebars, the drag header, the
 * glide-back after a rubber-banded drop, and dismissal by ×, Escape, or a
 * pointerdown outside itself and its trigger — which is what keeps at most
 * one panel open at a time.
 *
 * There is never a SECOND panel stacked on the first: a control inside the
 * panel that needs a rich editor (the colour swatch in the border / effect
 * popouts) pushes its view INTO this panel via `FloatingPanelDrillView` —
 * the header swaps to a back arrow + a contextual title, × still closes the
 * whole panel, and back returns to the main view with its state intact.
 *
 * Callers: the colour picker (ColorInput), the icon picker, and the
 * inspector's effect / border popouts. One implementation, so "the floating
 * editor" behaves identically wherever it appears.
 */

import {
  useCallback,
  useContext,
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
import { ChevronLeftIcon } from 'pixel-art-icons/icons/chevron-left'
import {
  FloatingPanelHostContext,
  type FloatingPanelDrill,
  type FloatingPanelHost,
} from './floatingPanelHost'
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

interface FloatingPanelDrillViewProps {
  /** Contextual header title naming what is edited (e.g. "Border color"). */
  title: string
  /** Fires from the header's back arrow (and Escape) — return to the main view. */
  onBack: () => void
  children: ReactNode
}

/**
 * Push a view into the enclosing FloatingPanel instead of stacking a second
 * panel. While mounted, the panel hides its main content (kept mounted, so
 * its state survives the round trip), shows `children` in its place, and the
 * header becomes back arrow + `title`. Unmounting — or the back arrow, which
 * calls `onBack` so the OWNER unmounts it — restores the main view. Renders
 * nothing outside a FloatingPanel.
 */
export function FloatingPanelDrillView({ title, onBack, children }: FloatingPanelDrillViewProps) {
  const host = useContext(FloatingPanelHostContext)
  const registerDrill = host?.registerDrill

  // Latest onBack through a ref: the registration effect below must not
  // depend on the callback's identity, or an unstable caller callback would
  // re-register (→ re-render → re-register) on every render.
  const onBackRef = useRef(onBack)
  useEffect(() => {
    onBackRef.current = onBack
  })
  useEffect(() => {
    if (!registerDrill) return
    return registerDrill({ title, onBack: () => onBackRef.current() })
  }, [registerDrill, title])

  if (host?.drillContainer == null) return null
  return createPortal(children, host.drillContainer)
}

interface FloatingPanelProps {
  open: boolean
  onClose: () => void
  /** The control the panel opens beside; also excluded from outside-close. */
  anchorRef: RefObject<HTMLElement | null>
  /** Header text. Also the accessible name unless `ariaLabel` overrides it. */
  title: ReactNode
  /**
   * When set, a back-arrow button leads the header — for panels that are one
   * step of a caller-managed navigation. Drill-in views set this internally
   * via `FloatingPanelDrillView`; the drill's back wins while one is active.
   */
  onBack?: () => void
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
  onBack,
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
  const [drill, setDrill] = useState<FloatingPanelDrill | null>(null)
  const [drillContainer, setDrillContainer] = useState<HTMLElement | null>(null)

  // Referenced in the drill view's registration-effect dependency array, so
  // it needs a GUARANTEED stable identity — an unstable one would re-register
  // on every render (memoization-rule exception 1).
  const registerDrill = useCallback((registration: FloatingPanelDrill) => {
    setDrill(registration)
    return () => setDrill((current) => (current === registration ? null : current))
  }, [])
  const host: FloatingPanelHost = { registerDrill, drillContainer }

  // Place on open, forget on close, so re-opening always lands beside the
  // trigger rather than where the user last dragged it. The panel is not in
  // the DOM yet at this point, so this first placement clamps from the
  // `estimatedHeight` guess — the effect below immediately re-clamps from the
  // real measurement once it mounts.
  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition(avoidObstacles(placeBesideAnchor(rect, width, estimatedHeight), width, estimatedHeight))
  }, [open, anchorRef, width, estimatedHeight])

  // Second pass and live re-clamp: once the panel is mounted its REAL size is
  // known, so re-run the obstacle/viewport clamping from the measurement. The
  // ResizeObserver keeps it fully on screen when the content later changes
  // size (the drill-in colour view is taller than most popout bodies), and a
  // window resize re-clamps too. Position identity is preserved when nothing
  // needs to move, so this never fights the drag or the glide-back.
  const mounted = open && position !== null
  useLayoutEffect(() => {
    if (!mounted) return
    const panel = panelRef.current
    if (!panel) return
    const reclamp = () => {
      setPosition((current) => {
        if (current === null) return current
        const panelWidth = panel.offsetWidth
        const panelHeight = panel.offsetHeight
        const next = avoidObstacles(
          clampPosition(current.x, current.y, panelWidth, panelHeight),
          panelWidth,
          panelHeight,
        )
        return next.x === current.x && next.y === current.y ? current : next
      })
    }
    reclamp()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reclamp)
    observer?.observe(panel)
    window.addEventListener('resize', reclamp)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', reclamp)
    }
  }, [mounted])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Dismissal: Escape, or a pointerdown outside the panel and its trigger.
  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      if (target instanceof Element) {
        if (keepOpenSelector && target.closest(keepOpenSelector)) return
        // A dropdown spawned from a field inside this panel — a Select's
        // listbox, a token menu — portals to <body>, so its clicks land
        // "outside" this panel's DOM. Anything portalled AFTER this panel in
        // document order is such a child surface; closing over it would
        // unmount the dropdown mid-pick.
        const overlay = target.closest('[role="menu"], [role="listbox"]')
        if (
          overlay &&
          panelRef.current &&
          panelRef.current.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          return
        }
      }
      onClose()
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      // Escape backs out of a drilled-in view first; only the next Escape
      // (or ×, or a click outside) closes the whole panel.
      if (drill) {
        drill.onBack()
        return
      }
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
  }, [open, onClose, anchorRef, keepOpenSelector, drill])

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

  // While a drill view is active, its contextual title and back arrow replace
  // the caller's header; × keeps closing the whole panel.
  const headerTitle = drill?.title ?? title
  const headerBack = drill?.onBack ?? onBack

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel ?? (typeof headerTitle === 'string' ? headerTitle : undefined)}
      className={cn(styles.panel, className)}
      // Portaled to <body>, so it declares its own surface ramp: a detached
      // piece of the chrome, not a card.
      data-surface="chrome"
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
        {headerBack && (
          <Button variant="ghost" size="xs" iconOnly aria-label="Back" onClick={headerBack}>
            <ChevronLeftIcon size={10} aria-hidden="true" />
          </Button>
        )}
        <span className={styles.title}>{headerTitle}</span>
        <Button variant="ghost" size="xs" iconOnly aria-label={closeLabel} onClick={onClose}>
          <CloseIcon size={10} aria-hidden="true" />
        </Button>
      </div>
      <FloatingPanelHostContext.Provider value={host}>
        {/* The main view stays MOUNTED under a drill so its state (active
            border side, half-typed fields) survives the round trip — only its
            display goes. */}
        <div className={styles.content} data-drilled={drill ? '' : undefined}>
          {children}
        </div>
        {drill && <div ref={setDrillContainer} />}
      </FloatingPanelHostContext.Provider>
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
