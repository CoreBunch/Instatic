import {
  useContext, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { useEvent } from '@ui/lib/useEvent'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { ChevronLeftIcon } from 'pixel-art-icons/icons/chevron-left'
import { FloatingPanelHostContext, type FloatingPanelDrill, type FloatingPanelHost } from './floatingPanelHost'
import styles from './FloatingPanel.module.css'

const PANEL_GAP = 8
const VIEWPORT_MARGIN = 8
const OBSTACLE_RESISTANCE = 0.25

interface Point { x: number; y: number }
interface PanelDrag {
  id: number
  offset: Point
  width: number
  height: number
  obstacles: DOMRect[]
}

interface FloatingPanelProps {
  anchorRef: RefObject<HTMLElement | null>
  title: string
  closeLabel: string
  onClose: () => void
  children: ReactNode
  width: number
  /** Companion editing surface, such as a gradient handle on the canvas. */
  keepOpenSelector?: string
}

/** Nested editors use their parent panel's content area and Back button. */
export default function FloatingPanel(props: FloatingPanelProps) {
  const host = useContext(FloatingPanelHostContext)
  return host
    ? <DrillView host={host} {...props} />
    : <PanelDialog {...props} />
}

function DrillView({
  host: { registerDrill, drillContainer }, title, onClose, anchorRef, children,
}: FloatingPanelProps & { host: FloatingPanelHost }) {
  const onBack = useEvent(onClose)
  useLayoutEffect(() => registerDrill({ title, onBack, anchor: anchorRef.current }), [registerDrill, title, onBack, anchorRef])
  return drillContainer && createPortal(children, drillContainer)
}

function PanelDialog({ anchorRef, title, closeLabel, onClose, children, width, keepOpenSelector }: FloatingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useRef<Point | null>(null)
  const moved = useRef(false)
  const drag = useRef<PanelDrag | null>(null)
  const insidePress = useRef<PointerEvent | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const [drill, setDrill] = useState<FloatingPanelDrill | null>(null)
  const [drillContainer, setDrillContainer] = useState<HTMLDivElement | null>(null)

  const registerDrill = useEvent((registration: FloatingPanelDrill) => {
    setDrill(registration)
    return () => setDrill((current) => current === registration ? null : current)
  })

  // Measure the rendered dialog, including lazy content, before paint. Until
  // the user drags it, resize keeps the panel beside its original trigger.
  const place = useEvent((next: Point) => {
    position.current = next
    panelRef.current?.style.setProperty('--floating-panel-x', `${next.x}px`)
    panelRef.current?.style.setProperty('--floating-panel-y', `${next.y}px`)
  })
  useLayoutEffect(() => {
    const panel = panelRef.current
    const anchor = anchorRef.current
    if (!panel || !anchor) return
    function reclamp() {
      if (!panel || !anchor || drag.current) return
      const rect = anchor.getBoundingClientRect()
      const left = rect.left - panel.offsetWidth - PANEL_GAP
      const origin = moved.current && position.current
        ? position.current
        : left >= VIEWPORT_MARGIN
          ? { x: left, y: rect.top }
          : { x: rect.left, y: rect.bottom + PANEL_GAP }
      place(containPanel(origin, panel.offsetWidth, panel.offsetHeight, measureObstacles()))
    }
    reclamp()
    panel.focus({ preventScroll: true })
    const observer = new ResizeObserver(reclamp)
    observer.observe(panel)
    window.addEventListener('resize', reclamp)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reclamp)
    }
  }, [anchorRef, place])

  useLayoutEffect(() => {
    if (drill) panelRef.current?.focus({ preventScroll: true })
    else if (restoreFocus.current) {
      restoreFocus.current.focus({ preventScroll: true })
      restoreFocus.current = null
    }
  }, [drill])

  const outsidePress = useEvent((event: PointerEvent) => {
    // React capture follows the component tree across portals. A listbox
    // opened by this panel is inside; a menu opened elsewhere is outside.
    if (event === insidePress.current) return
    const target = event.target
    if (!(target instanceof Node) || anchorRef.current?.contains(target)) return
    if (keepOpenSelector && target instanceof Element && target.closest(keepOpenSelector)) return
    onClose()
  })
  useEffect(() => {
    document.addEventListener('pointerdown', outsidePress)
    return () => document.removeEventListener('pointerdown', outsidePress)
  }, [outsidePress])

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const panel = panelRef.current
    if (!panel || !event.isPrimary || event.button !== 0 || drag.current) return
    if (event.target instanceof Element && event.target.closest('button')) return
    const rect = panel.getBoundingClientRect()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    panel.classList.remove(styles.gliding)
    drag.current = {
      id: event.pointerId, offset: { x: event.clientX - rect.left, y: event.clientY - rect.top },
      width: rect.width, height: rect.height, obstacles: measureObstacles(),
    }
  }
  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current
    if (!active || event.pointerId !== active.id) return
    moved.current = true
    const raw = { x: event.clientX - active.offset.x, y: event.clientY - active.offset.y }
    const allowed = containPanel(raw, active.width, active.height, active.obstacles)
    place({
      x: allowed.x + (raw.x - allowed.x) * OBSTACLE_RESISTANCE,
      y: allowed.y + (raw.y - allowed.y) * OBSTACLE_RESISTANCE,
    })
  }
  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const panel = panelRef.current
    const last = position.current
    if (!panel || !last || drag.current?.id !== event.pointerId) return
    drag.current = null
    const settled = containPanel(last, panel.offsetWidth, panel.offsetHeight, measureObstacles())
    if (settled.x !== last.x || settled.y !== last.y) panel.classList.add(styles.gliding)
    place(settled)
  }
  function close() {
    onClose()
    anchorRef.current?.focus({ preventScroll: true })
  }
  function back() {
    if (!drill) return
    restoreFocus.current = drill.anchor
    drill.onBack()
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
      aria-label={drill?.title ?? title}
      className={styles.panel}
      data-surface="chrome"
      style={{ '--floating-panel-width': `${width}px` } as CSSProperties}
      onPointerDownCapture={(event) => { insidePress.current = event.nativeEvent }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        if (drill) back()
        else close()
      }}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && (event.propertyName === 'left' || event.propertyName === 'top')) {
          event.currentTarget.classList.remove(styles.gliding)
        }
      }}
    >
      <div className={styles.header} onPointerDown={beginDrag} onPointerMove={moveDrag}
        onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
        {drill && (
          <Button variant="ghost" size="xs" iconOnly aria-label="Back" onClick={back}>
            <ChevronLeftIcon size={10} aria-hidden="true" />
          </Button>
        )}
        <span className={styles.title}>{drill?.title ?? title}</span>
        <Button variant="ghost" size="xs" iconOnly aria-label={closeLabel} onClick={close}>
          <CloseIcon size={10} aria-hidden="true" />
        </Button>
      </div>
      <FloatingPanelHostContext.Provider value={{ registerDrill, drillContainer }}>
        <div className={styles.content} data-drilled={drill ? '' : undefined}>{children}</div>
        {/* Keep the portal target mounted while lazy drill content suspends. */}
        <div ref={setDrillContainer} hidden={!drill} />
      </FloatingPanelHostContext.Provider>
    </div>,
    document.body,
  )
}

function measureObstacles(): DOMRect[] {
  return Array.from(document.querySelectorAll('[data-floating-obstacle]'), (el) => el.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
}

function containPanel(point: Point, width: number, height: number, obstacles: DOMRect[]): Point {
  const clampX = (x: number) => Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - width - VIEWPORT_MARGIN))
  let x = clampX(point.x)
  const y = Math.max(VIEWPORT_MARGIN, Math.min(point.y, window.innerHeight - height - VIEWPORT_MARGIN))
  for (const rect of obstacles) {
    if (x < rect.right && x + width > rect.left && y < rect.bottom && y + height > rect.top) {
      x = clampX(rect.left + rect.width / 2 > window.innerWidth / 2
        ? rect.left - width - PANEL_GAP
        : rect.right + PANEL_GAP)
    }
  }
  return { x, y }
}
