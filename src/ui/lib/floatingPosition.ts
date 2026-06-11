/**
 * floatingPosition — shared positioning logic for floating elements that
 * need to anchor to a trigger and flip into the side with the most
 * available viewport space.
 *
 * Used by:
 *   - Tooltip (hover bubbles, four-side flip)
 *   - ContextMenu (anchored dropdown menus, four-side flip)
 *
 * The helper takes a trigger rect, the floating element's measured size,
 * a preferred side, an alignment, and a gap. It tries each candidate side
 * in priority order and returns the first one that fits inside the
 * viewport. If none fits, it picks the side with the most available space
 * and clamps the rectangle to the viewport.
 */

export type FloatingSide = 'top' | 'bottom' | 'left' | 'right' | 'auto'
export type FloatingAlign = 'start' | 'center' | 'end'
export type ResolvedFloatingSide = 'top' | 'bottom' | 'left' | 'right'

interface FloatingRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

interface FloatingPosition {
  /** Final clamped x coordinate (left edge) in viewport pixels. */
  x: number
  /** Final clamped y coordinate (top edge) in viewport pixels. */
  y: number
  /** Resolved side after flip / fallback. */
  side: ResolvedFloatingSide
  /**
   * Distance from the floating element's leading edge to the centre of the
   * trigger along the cross-axis — used to pin a tooltip/menu arrow so it
   * stays anchored even when the bubble itself is shifted to fit on-screen.
   */
  arrowOffset: number
}

interface FloatingPositionOptions {
  /** Floating element width. */
  floatingWidth: number
  /** Floating element height. */
  floatingHeight: number
  /** Preferred side; 'auto' tries the priority list defined by `autoPriority`. */
  side?: FloatingSide
  /** Cross-axis alignment relative to the trigger. */
  align?: FloatingAlign
  /** Gap between the trigger edge and the floating element, in px. */
  offset?: number
  /** Margin from the viewport edges, in px. */
  viewportMargin?: number
  /** Extra outward bias added on top of `offset`. Used by Tooltip's arrow. */
  edgePadding?: number
  /** Minimum distance of the arrow from the bubble's leading edge. */
  arrowEdgePad?: number
  /**
   * Side priority order tried when `side === 'auto'`.
   * - Tooltip uses ['top', 'bottom', 'right', 'left'] (prefers showing above).
   * - Dropdown menus use ['bottom', 'top', 'right', 'left'] (prefers below).
   */
  autoPriority?: ReadonlyArray<ResolvedFloatingSide>
}

const DEFAULT_AUTO_PRIORITY: ReadonlyArray<ResolvedFloatingSide> = [
  'top',
  'bottom',
  'right',
  'left',
]

function alignedX(trigger: FloatingRect, floatingWidth: number, align: FloatingAlign): number {
  if (align === 'start') return trigger.left
  if (align === 'end') return trigger.right - floatingWidth
  return trigger.left + trigger.width / 2 - floatingWidth / 2
}

function alignedY(trigger: FloatingRect, floatingHeight: number, align: FloatingAlign): number {
  if (align === 'start') return trigger.top
  if (align === 'end') return trigger.bottom - floatingHeight
  return trigger.top + trigger.height / 2 - floatingHeight / 2
}

interface SideCandidate {
  x: number
  y: number
  fits: boolean
  arrowOffset: number
}

function sideCandidate(
  side: ResolvedFloatingSide,
  trigger: FloatingRect,
  fw: number,
  fh: number,
  align: FloatingAlign,
  offset: number,
  viewportMargin: number,
  edgePadding: number,
  arrowEdgePad: number,
): SideCandidate {
  const vw = window.innerWidth
  const vh = window.innerHeight

  let rawX: number
  let rawY: number

  if (side === 'top') {
    rawX = alignedX(trigger, fw, align)
    rawY = trigger.top - fh - offset - edgePadding
  } else if (side === 'bottom') {
    rawX = alignedX(trigger, fw, align)
    rawY = trigger.bottom + offset + edgePadding
  } else if (side === 'left') {
    rawX = trigger.left - fw - offset - edgePadding
    rawY = alignedY(trigger, fh, align)
  } else {
    rawX = trigger.right + offset + edgePadding
    rawY = alignedY(trigger, fh, align)
  }

  const fits =
    rawX >= viewportMargin &&
    rawX + fw <= vw - viewportMargin &&
    rawY >= viewportMargin &&
    rawY + fh <= vh - viewportMargin

  const x = Math.max(viewportMargin, Math.min(rawX, vw - fw - viewportMargin))
  const y = Math.max(viewportMargin, Math.min(rawY, vh - fh - viewportMargin))

  let arrowOffset: number
  if (side === 'top' || side === 'bottom') {
    const cx = trigger.left + trigger.width / 2
    arrowOffset = Math.max(arrowEdgePad, Math.min(fw - arrowEdgePad, cx - x))
  } else {
    const cy = trigger.top + trigger.height / 2
    arrowOffset = Math.max(arrowEdgePad, Math.min(fh - arrowEdgePad, cy - y))
  }

  return { x, y, fits, arrowOffset }
}

/**
 * Compute the best position for a floating element relative to a trigger.
 * Tries the preferred side first; on overflow, picks the side with the most
 * available space and clamps to the viewport.
 */
export function computeFloatingPosition(
  trigger: FloatingRect,
  options: FloatingPositionOptions,
): FloatingPosition {
  const {
    floatingWidth: fw,
    floatingHeight: fh,
    side = 'auto',
    align = 'center',
    offset = 8,
    viewportMargin = 8,
    edgePadding = 0,
    arrowEdgePad = 6,
    autoPriority = DEFAULT_AUTO_PRIORITY,
  } = options

  const vw = window.innerWidth
  const vh = window.innerHeight

  const candidates: ResolvedFloatingSide[] =
    side === 'auto' ? [...autoPriority] : [side as ResolvedFloatingSide]

  // Try each side in priority order; return on the first that fits.
  for (const s of candidates) {
    const c = sideCandidate(s, trigger, fw, fh, align, offset, viewportMargin, edgePadding, arrowEdgePad)
    if (c.fits) return { x: c.x, y: c.y, arrowOffset: c.arrowOffset, side: s }
  }

  // No side fits — pick the one with the most available space and clamp.
  const scored = (
    side === 'auto' ? [...autoPriority] : [side as ResolvedFloatingSide]
  ).map((s) => {
    const space =
      s === 'top'
        ? trigger.top
        : s === 'bottom'
          ? vh - trigger.bottom
          : s === 'right'
            ? vw - trigger.right
            : trigger.left
    return { s, space }
  })
  scored.sort((a, b) => b.space - a.space)
  const best = scored[0].s
  const c = sideCandidate(best, trigger, fw, fh, align, offset, viewportMargin, edgePadding, arrowEdgePad)
  return { x: c.x, y: c.y, arrowOffset: c.arrowOffset, side: best }
}
