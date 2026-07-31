/**
 * Tooltip — lightweight hover/focus tooltip primitive.
 *
 * Renders content through a shared portal (#tooltip-root on document.body).
 * Position is computed by an inline helper — no @floating-ui dependency.
 *
 * Shows while the trigger is hovered, and optionally while focused. Hides after
 * both interactions leave, or on Escape, scroll, or pointerdown outside.
 *
 * Trigger element: captured from e.currentTarget on mouseenter/focus. It is
 * state because its presence participates in whether the portal renders and
 * its identity drives position/dismiss effects.
 *
 * Accessibility: the tooltip element carries role="tooltip" and a stable id
 * (from useId). The trigger child receives aria-describedby while the tooltip
 * is visible; on hide the attribute is removed.
 */

import {
  cloneElement,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@ui/cn'
import {
  computeFloatingPosition,
  type FloatingAlign,
  type FloatingSide,
  type ResolvedFloatingSide,
} from '@ui/lib/floatingPosition'
import styles from './Tooltip.module.css'

// ─── Public types ─────────────────────────────────────────────────────────────

export type TooltipSide = FloatingSide
type TooltipAlign = FloatingAlign

interface TooltipProps {
  /** Tooltip content — string or simple JSX. */
  content: ReactNode
  /** Which side to prefer. 'auto' tries top→bottom→right→left. Default: 'auto'. */
  side?: TooltipSide
  /** Alignment along the cross-axis. Default: 'center'. */
  align?: TooltipAlign
  /** Gap between trigger and tooltip bubble in px. Default: 8. */
  offset?: number
  /** Wider bubble for graphical status cards. Default: `default`. */
  size?: 'default' | 'wide'
  /** Also show on keyboard focus. Use for status/details not repeated elsewhere. */
  openOnFocus?: boolean
  /** If true, render children as-is without any tooltip wrapping. */
  disabled?: boolean
  /** Single trigger element. Must accept mouse event handlers. */
  children: ReactElement
}

// ─── Portal root ─────────────────────────────────────────────────────────────

/** Lazily appends a single #tooltip-root container to document.body. */
function getTooltipRoot(): HTMLElement {
  let root = document.getElementById('tooltip-root')
  if (!root) {
    root = document.createElement('div')
    root.id = 'tooltip-root'
    document.body.appendChild(root)
  }
  return root
}

// ─── Position computation ─────────────────────────────────────────────────────

/** Half of the 6px rotated-square arrow — adds outward padding past `offset`. */
const ARROW_HALF = 3
/** Tooltip auto-priority: prefer above the trigger, then below, then sides. */
const TOOLTIP_AUTO_PRIORITY = ['top', 'bottom', 'right', 'left'] as const

// ─── Inner component (all hooks live here) ───────────────────────────────────

/** Props the Tooltip composes with on the trigger child. */
interface TriggerChildProps {
  onMouseEnter?: React.MouseEventHandler<HTMLElement>
  onMouseLeave?: React.MouseEventHandler<HTMLElement>
  onFocus?: React.FocusEventHandler<HTMLElement>
  onBlur?: React.FocusEventHandler<HTMLElement>
  'aria-describedby'?: string
}

function TooltipInner({
  content,
  side,
  align,
  offset,
  size,
  openOnFocus,
  children,
}: Required<Omit<TooltipProps, 'disabled'>>) {
  const id = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [triggerEl, setTriggerEl] = useState<HTMLElement | null>(null)
  const shown = (hovered || (openOnFocus && focused)) && triggerEl !== null
  const [position, setPosition] = useState<{
    x: number
    y: number
    arrowOffset: number
    side: ResolvedFloatingSide
  } | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)

  const hide = useEffectEvent(() => {
    setHovered(false)
    setFocused(false)
    setPosition(null)
  })

  // Measure bubble and compute position after it enters the DOM.
  useLayoutEffect(() => {
    if (!shown || !triggerEl || !bubbleRef.current) return
    const triggerRect = triggerEl.getBoundingClientRect()
    const { width, height } = bubbleRef.current.getBoundingClientRect()
    setPosition(
      computeFloatingPosition(triggerRect, {
        floatingWidth: width,
        floatingHeight: height,
        side,
        align,
        offset,
        edgePadding: ARROW_HALF,
        autoPriority: TOOLTIP_AUTO_PRIORITY,
      }),
    )
  }, [shown, triggerEl, side, align, offset])

  // Global dismiss: scroll (hide), Escape (hide), pointerdown outside (hide).
  useEffect(() => {
    if (!shown || !triggerEl) return

    const onScroll = () => hide()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      hide()
    }
    const onPointerDown = (e: PointerEvent) => {
      if (!triggerEl.contains(e.target as Node)) hide()
    }

    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    // Capture lets the tooltip consume Escape before a parent panel's document
    // handler sees it and closes the whole surface.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('pointerdown', onPointerDown)

    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [shown, triggerEl])

  // Compose with the child's existing handlers; inject aria-describedby.
  // Closures here capture only state setters and callbacks — no useRef values.
  const childTyped = children as ReactElement<TriggerChildProps>
  const existingMouseEnter = childTyped.props.onMouseEnter
  const existingMouseLeave = childTyped.props.onMouseLeave
  const existingFocus = childTyped.props.onFocus
  const existingBlur = childTyped.props.onBlur
  const existingDescribedBy = childTyped.props['aria-describedby']
  const describedBy = [existingDescribedBy, shown ? id : null]
    .filter(Boolean)
    .join(' ') || undefined

  const cloned = cloneElement(childTyped, {
    'aria-describedby': describedBy,
    onMouseEnter(e: React.MouseEvent<HTMLElement>) {
      existingMouseEnter?.(e)
      // Capture the trigger element from the event (event handler, not render).
      setTriggerEl(e.currentTarget)
      setHovered(true)
    },
    onMouseLeave(e: React.MouseEvent<HTMLElement>) {
      existingMouseLeave?.(e)
      setHovered(false)
      if (!focused) setPosition(null)
    },
    onFocus(e: React.FocusEvent<HTMLElement>) {
      existingFocus?.(e)
      if (!openOnFocus) return
      setTriggerEl(e.currentTarget)
      setFocused(true)
    },
    onBlur(e: React.FocusEvent<HTMLElement>) {
      existingBlur?.(e)
      if (!openOnFocus) return
      setFocused(false)
      if (!hovered) setPosition(null)
    },
  })

  const bubbleStyle = {
    '--tooltip-x': position ? `${position.x}px` : '0px',
    '--tooltip-y': position ? `${position.y}px` : '0px',
    '--tooltip-arrow-offset': position ? `${position.arrowOffset}px` : '0px',
  } as CSSProperties

  return (
    <>
      {cloned}
      {shown &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className={cn(
              styles.bubble,
              size === 'wide' && styles.bubbleWide,
              position !== null && styles.visible,
            )}
            data-side={position?.side ?? 'top'}
            style={bubbleStyle}
          >
            {content}
            <div className={styles.arrow} />
          </div>,
          getTooltipRoot(),
        )}
    </>
  )
}

// ─── Public component ─────────────────────────────────────────────────────────

/**
 * Tooltip wraps a single trigger element and shows a floating label on hover.
 * Set `openOnFocus` when the detail must also be available to keyboard users.
 *
 * When `disabled` is true the children are returned untouched — no portal,
 * no event handlers, no aria injection.
 */
export function Tooltip({
  disabled = false,
  side = 'auto',
  align = 'center',
  offset = 8,
  size = 'default',
  openOnFocus = false,
  content,
  children,
}: TooltipProps) {
  // Return children as-is; no hooks needed in the disabled path.
  if (disabled) return children

  return (
    <TooltipInner
      content={content}
      side={side}
      align={align}
      offset={offset}
      size={size}
      openOnFocus={openOnFocus}
    >
      {children}
    </TooltipInner>
  )
}
