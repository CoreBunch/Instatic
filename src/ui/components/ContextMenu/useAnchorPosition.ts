import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import {
  computeFloatingPosition,
  type FloatingAlign,
  type FloatingSide,
  type ResolvedFloatingSide,
} from '@ui/lib/floatingPosition'
import { useEvent } from '@ui/lib/useEvent'

/**
 * Dropdown auto-priority: prefer opening below the trigger, then above,
 * then to the right, then to the left.
 *
 * This is intentionally different from the Tooltip auto-priority (which
 * starts at `top`) because dropdown menus that open *upward* by default
 * feel inverted; users expect them to drop *down*.
 */
const DROPDOWN_AUTO_PRIORITY = ['bottom', 'top', 'right', 'left'] as const

interface AnchorPosition {
  x: number
  y: number
  side: ResolvedFloatingSide
}

interface UseAnchorPositionParams {
  /** Element whose rect anchors the menu, and gates dismiss handling. */
  anchorRef: RefObject<HTMLElement | null> | undefined
  /** Ref to the menu element being positioned (measured for auto-flip). */
  menuRef: RefObject<HTMLDivElement | null>
  /** Optional override for the rect used to position the menu. */
  getAnchorRect: (() => DOMRect | null) | undefined
  side: FloatingSide
  align: FloatingAlign
  offset: number
  /** Explicit render width the CSS applies (used in position math). */
  width: number
  /** Lower bound for `matchAnchorWidth`. */
  minWidth: number
  /** Optional width ceiling applied after `matchAnchorWidth`. */
  maxWidth: number | undefined
  maxHeight: number | undefined
  /** When set, the menu's width tracks the anchor's measured width. */
  matchAnchorWidth: boolean
}

interface UseAnchorPositionResult {
  /** Auto-flipped position, or `null` until the menu has been measured. */
  position: AnchorPosition | null
  /** Render width after applying `matchAnchorWidth` and `maxWidth`. */
  effectiveWidth: number
}

/**
 * Anchor-based auto-flip positioning for {@link ContextMenu}.
 *
 * Measures the menu and the anchor in a layout effect, then chooses the best
 * side via the shared floating-position helper. Mirrors the auto-flip
 * behaviour of <Tooltip> so dropdown menus never overflow off-screen.
 *
 * Also owns `matchAnchorWidth`: when enabled, the anchor's measured width is
 * tracked via ResizeObserver and folded into `effectiveWidth`, so the dropdown
 * stays glued to the trigger's width even as the surrounding panel resizes.
 *
 * No-op for positioning when `anchorRef` is absent — the menu is then in
 * point mode (see {@link usePointPosition}). Width constraints still apply.
 */
export function useAnchorPosition({
  anchorRef,
  menuRef,
  getAnchorRect,
  side,
  align,
  offset,
  width,
  minWidth,
  maxWidth,
  maxHeight,
  matchAnchorWidth,
}: UseAnchorPositionParams): UseAnchorPositionResult {
  const [position, setPosition] = useState<AnchorPosition | null>(null)
  // Live anchor width, used when `matchAnchorWidth` is set. Tracked via
  // ResizeObserver so the dropdown stays glued to the trigger's width
  // even as the surrounding panel resizes.
  const [anchorWidth, setAnchorWidth] = useState<number | null>(null)

  // Effective render width: when `matchAnchorWidth` is set, the menu expands
  // to the anchor's measured width, then clamps to the optional `maxWidth`
  // ceiling while never shrinking below the `minWidth` floor.
  const anchorMatchedWidth = matchAnchorWidth && anchorWidth != null
    ? Math.max(anchorWidth, minWidth)
    : width
  const effectiveWidth = maxWidth != null
    ? Math.min(anchorMatchedWidth, maxWidth)
    : anchorMatchedWidth

  const recompute = useEvent(() => {
    if (!anchorRef) return
    const anchorEl = anchorRef.current
    const menuEl = menuRef.current
    if (!anchorEl || !menuEl) return
    // Position math uses `getAnchorRect()` when provided so callers can
    // decouple the dismiss-handling anchor (`anchorRef`) from the rect
    // used for positioning (e.g. wider parent for X/width, trigger for Y).
    const anchorRect = getAnchorRect?.() ?? anchorEl.getBoundingClientRect()
    const menuRect = menuEl.getBoundingClientRect()
    // Use the explicit `width` (which the CSS renders to) rather than the
    // measured rect width — this keeps positioning predictable in jsdom tests
    // and avoids double-counting any layout-time width clamping. When
    // `maxHeight` caps the menu, the measured rect already reflects the capped
    // height (CSS applies `max-height` before getBoundingClientRect). Still
    // defensively clamp here so position calculations agree with the rendered
    // size even on the very first measurement.
    const effectiveHeight = maxHeight != null
      ? Math.min(menuRect.height, maxHeight)
      : menuRect.height
    const next = computeFloatingPosition(anchorRect, {
      floatingWidth: effectiveWidth,
      floatingHeight: effectiveHeight,
      side,
      align,
      offset,
      autoPriority: DROPDOWN_AUTO_PRIORITY,
    })
    setPosition({ x: next.x, y: next.y, side: next.side })
  })

  useLayoutEffect(() => {
    if (!anchorRef) return
    recompute()
    // `anchorWidth` is intentionally a dep — when the anchor resizes (and
    // `matchAnchorWidth` is on) the dropdown's own width changes, so the
    // floating-position math must run again to keep alignment correct.
  }, [anchorRef, anchorWidth, recompute])

  // Re-run the position math whenever the menu's own measured size changes.
  // Menu content can grow *after* the first measuring frame — e.g. ModelPicker
  // lazy-loads its model lists once opened, so the menu mounts short and fills
  // in asynchronously. Without this, a menu that auto-flipped to `top` (trigger
  // near the viewport bottom) keeps the `top` edge it picked for the short
  // height, then grows downward off-screen as content arrives. Observing the
  // menu reflows the position the moment it resizes.
  useLayoutEffect(() => {
    if (!anchorRef) return
    const menuEl = menuRef.current
    if (!menuEl || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => recompute())
    observer.observe(menuEl)
    return () => observer.disconnect()
  }, [anchorRef, menuRef, recompute])

  // Track the anchor's measured width so `matchAnchorWidth` dropdowns
  // can render flush with their trigger and respond to panel resizes.
  useLayoutEffect(() => {
    if (!matchAnchorWidth || !anchorRef) return
    const anchorEl = anchorRef.current
    if (!anchorEl) return
    setAnchorWidth(anchorEl.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setAnchorWidth(entry.contentRect.width)
    })
    observer.observe(anchorEl)
    return () => observer.disconnect()
  }, [matchAnchorWidth, anchorRef])

  // Position recomputes on window resize and capture-phase scroll while the
  // menu is open, so the menu stays glued to the trigger.
  useEffect(() => {
    if (!anchorRef) return
    function onViewportChange() {
      recompute()
    }
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [anchorRef, recompute])

  return { position, effectiveWidth }
}
