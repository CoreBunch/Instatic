/**
 * Crop geometry — the pure math behind `CropDialog`.
 *
 * Kept out of the component because every interesting failure mode here is
 * arithmetic (a rectangle escaping the frame, a ratio snap collapsing to zero
 * width, a preview scale dividing by zero) and none of it needs React to
 * reproduce. `cropGeometry.test.ts` exercises it directly.
 *
 * Every rectangle is expressed in fractions of the source image: `x`/`y` are
 * the top-left corner, `width`/`height` the extent, all within 0–1. That's the
 * same unit the server stores (`media_assets.crop_json`), so nothing has to be
 * converted at the boundary.
 */

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export const FULL_FRAME: CropRect = { x: 0, y: 0, width: 1, height: 1 }

/** Smallest crop we let the user drag to — below this the handles overlap. */
const MIN_EXTENT = 0.05

/** Smallest focus ellipse, in the same fractions. Keeps the handle grabbable. */
const MIN_FOCUS_EXTENT = 0.04

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** True when the rectangle covers the whole frame (i.e. "no crop"). */
export function isFullFrame(rect: CropRect): boolean {
  return rect.x <= 0.0001 && rect.y <= 0.0001 && rect.width >= 0.9999 && rect.height >= 0.9999
}

/** Push a rectangle back inside the frame without changing its size if possible. */
export function clampRect(rect: CropRect): CropRect {
  const width = clamp(rect.width, MIN_EXTENT, 1)
  const height = clamp(rect.height, MIN_EXTENT, 1)
  return {
    width,
    height,
    x: clamp(rect.x, 0, 1 - width),
    y: clamp(rect.y, 0, 1 - height),
  }
}

/** Move the rectangle by a delta in frame fractions, keeping it inside. */
export function moveRect(rect: CropRect, dx: number, dy: number): CropRect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy })
}

/**
 * Eight drag handles: four corners, four edge midpoints. The corners move both
 * axes, the edges move exactly one — dragging the top edge down must not pull
 * the left edge with it, which is the whole reason the edge handles exist.
 */
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const MOVES_X: Record<CropHandle, 'left' | 'right' | null> = {
  nw: 'left', w: 'left', sw: 'left',
  ne: 'right', e: 'right', se: 'right',
  n: null, s: null,
}

const MOVES_Y: Record<CropHandle, 'top' | 'bottom' | null> = {
  nw: 'top', n: 'top', ne: 'top',
  sw: 'bottom', s: 'bottom', se: 'bottom',
  w: null, e: null,
}

/**
 * Drag one handle to a new position. The opposite edge is the anchor on each
 * axis the handle actually moves, so the rectangle can be inverted through it
 * without ever going negative — the min/max pair below is what keeps the
 * extent positive when the pointer crosses the anchor. Axes the handle does
 * not own keep their current edges untouched.
 */
export function resizeRect(rect: CropRect, handle: CropHandle, pointerX: number, pointerY: number): CropRect {
  const left = rect.x
  const top = rect.y
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height

  const px = clamp(pointerX, 0, 1)
  const py = clamp(pointerY, 0, 1)

  const movesX = MOVES_X[handle]
  const movesY = MOVES_Y[handle]

  // Anchor = the edge that stays put. On an axis the handle does not own, both
  // "anchor" and "edge" are the current edges, which reproduces the extent.
  const anchorX = movesX === 'left' ? right : left
  const edgeX = movesX === null ? right : px
  const anchorY = movesY === 'top' ? bottom : top
  const edgeY = movesY === null ? bottom : py

  return clampRect({
    x: Math.min(anchorX, edgeX),
    y: Math.min(anchorY, edgeY),
    width: Math.abs(anchorX - edgeX),
    height: Math.abs(anchorY - edgeY),
  })
}

/**
 * Snap a rectangle to a target aspect ratio, keeping its centre.
 *
 * `ratio` is width/height in RENDERED pixels, so the image's own aspect ratio
 * has to come in too: a 1:1 crop of a 3000×2000 photo is 0.667 of the width
 * but 1.0 of the height in fraction space. Getting this wrong is the classic
 * "square preset produces a rectangle" bug.
 */
export function applyRatio(rect: CropRect, ratio: number, imageAspect: number): CropRect {
  const centreX = rect.x + rect.width / 2
  const centreY = rect.y + rect.height / 2

  // Fraction-space ratio: how many frame-widths per frame-height.
  const target = ratio / imageAspect

  // Start from the largest rectangle with this ratio that fits the current
  // one, so a ratio switch never grows the selection past the frame.
  let width = rect.width
  let height = width / target
  if (height > rect.height) {
    height = rect.height
    width = height * target
  }

  // Then grow it back toward the frame edges as far as the ratio allows, so
  // repeated preset clicks don't shrink the crop into nothing.
  const maxWidth = Math.min(1, target * 1)
  const maxHeight = Math.min(1, 1 / target)
  const scale = Math.min(maxWidth / width, maxHeight / height)
  if (scale > 1) {
    width *= scale
    height *= scale
  }

  return clampRect({
    x: centreX - width / 2,
    y: centreY - height / 2,
    width,
    height,
  })
}

/**
 * Editorial focus area — an ellipse in fractions of the ORIGINAL image.
 * `x`/`y` are its CENTRE (unlike `CropRect`, whose x/y are a corner), and
 * `width`/`height` its full extent, so the ellipse spans `x ± width / 2` by
 * `y ± height / 2`.
 *
 * Centre-based on purpose: every operation on a focus area is either "where is
 * the subject" or "how big is the subject", and both are naturally expressed
 * from the middle out. A corner origin would make every move a two-field
 * update and every resize a four-field one.
 */
export interface FocusArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The focus area an image gets before anyone touches it: a circle centred on
 * the crop, at 60% of its shorter side.
 *
 * Circular in RENDERED pixels, which is why `imageAspect` is needed — equal
 * fractions on a 3:2 photo draw an ellipse, and an untouched default must not
 * look like a deliberate editorial choice.
 */
export function defaultFocusArea(rect: CropRect, imageAspect: number): FocusArea {
  const cropAspect = (rect.width / rect.height) * imageAspect
  // Take 60% of the shorter rendered side, then express that one diameter in
  // each axis's own fraction space — which is where the aspect division goes.
  const width = cropAspect >= 1 ? (rect.width * 0.6) / cropAspect : rect.width * 0.6
  const height = cropAspect >= 1 ? rect.height * 0.6 : rect.height * 0.6 * cropAspect
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    width,
    height,
  }
}

/**
 * Keep the focus ellipse inside the crop. An ellipse reaching outside it would
 * point at pixels the crop threw away, and `object-position` would clamp
 * anyway — doing it here means the UI shows the same answer the published page
 * will use.
 *
 * The extent is clamped BEFORE the centre: an ellipse wider than the crop has
 * no legal centre at all, so it is shrunk to fit first and only then pushed
 * back in bounds.
 */
export function clampFocusArea(area: FocusArea, rect: CropRect): FocusArea {
  const width = clamp(area.width, MIN_FOCUS_EXTENT, rect.width)
  const height = clamp(area.height, MIN_FOCUS_EXTENT, rect.height)
  return {
    width,
    height,
    x: clamp(area.x, rect.x + width / 2, rect.x + rect.width - width / 2),
    y: clamp(area.y, rect.y + height / 2, rect.y + rect.height - height / 2),
  }
}

/**
 * Move the ellipse by a pointer delta from where the drag started.
 *
 * Delta rather than "centre = pointer" so grabbing the puck slightly off its
 * middle does not teleport the ellipse under the cursor on the first frame.
 * `origin` is the area as it was when the pointer went down.
 */
export function moveFocusArea(origin: FocusArea, dx: number, dy: number, rect: CropRect): FocusArea {
  return clampFocusArea({ ...origin, x: origin.x + dx, y: origin.y + dy }, rect)
}

/**
 * Resize the ellipse by dragging the handle on its rim, again by delta from
 * the drag start. The centre stays put and each axis grows by twice the
 * pointer's travel on that axis, so one handle can produce a tall, a wide or a
 * round area — which is the difference between "the subject is a face" and
 * "the subject is a landscape band".
 *
 * Twice, because the extent grows symmetrically about the fixed centre: the
 * rim moves by the pointer delta, the full width by double it.
 *
 * A delta also avoids the trigonometry a rim handle would otherwise need. The
 * handle sits at 45° on the ellipse, so its distance to the centre is not the
 * semi-axis, and reading the extent straight off the pointer position would
 * shrink the ellipse by a factor of √2 the instant it was grabbed.
 */
export function resizeFocusArea(
  origin: FocusArea,
  dx: number,
  dy: number,
  rect: CropRect,
): FocusArea {
  return clampFocusArea(
    {
      ...origin,
      width: origin.width + dx * 2,
      height: origin.height + dy * 2,
    },
    rect,
  )
}

/**
 * The focus area expressed in fractions of the CROP, i.e. where it lands
 * inside the cropped frame. Drives the ellipse overlay in each preview box and
 * the preview offsets; the publisher performs the same conversion for
 * `object-position`, from the same stored numbers.
 */
export function focusAreaWithinCrop(area: FocusArea, rect: CropRect): FocusArea {
  return {
    x: rect.width > 0 ? clamp((area.x - rect.x) / rect.width, 0, 1) : 0.5,
    y: rect.height > 0 ? clamp((area.y - rect.y) / rect.height, 0, 1) : 0.5,
    width: rect.width > 0 ? clamp(area.width / rect.width, 0, 1) : 1,
    height: rect.height > 0 ? clamp(area.height / rect.height, 0, 1) : 1,
  }
}

/**
 * CSS values that render `rect` of an image into a preview box of `boxAspect`
 * (width/height) exactly the way the published page will: covering the box,
 * scrolled so the focus centre stays in view — the arithmetic behind
 * `object-fit: cover` plus `object-position`.
 *
 * Cover, not contain: these previews answer "what does this image look like in
 * a 16:9 slot on the site", and the site crops with cover. A contained preview
 * with letterboxing answers a question nobody asked and, worse, hides exactly
 * the edges the real slot would cut.
 *
 * Returned as plain numbers/strings for the component to hand to CSS custom
 * properties — the styling itself stays in the stylesheet.
 */
export function previewStyle(
  rect: CropRect,
  imageAspect: number,
  boxAspect: number,
  focusInCrop: { x: number; y: number },
): {
  size: string
  position: string
  innerWidth: string
  innerHeight: string
  offsetX: string
  offsetY: string
} {
  // Background trick: scale the image up so the crop fills the element, then
  // offset it so the crop's top-left lands at the element's origin. The
  // denominators go to zero for a full-width/height crop, where any offset is
  // equally correct — 0 keeps it stable.
  const sizeX = (1 / rect.width) * 100
  const sizeY = (1 / rect.height) * 100
  const posX = rect.width >= 1 ? 0 : (rect.x / (1 - rect.width)) * 100
  const posY = rect.height >= 1 ? 0 : (rect.y / (1 - rect.height)) * 100

  // Cover scaling: the proportionally SHORTER axis fills the box exactly, the
  // longer one overflows and gets scrolled by the focal point. Both
  // percentages are of the BOX, so the overflow is simply (value - 100).
  const cropAspect = (rect.width / rect.height) * imageAspect
  const innerWidthPct = cropAspect >= boxAspect ? (cropAspect / boxAspect) * 100 : 100
  const innerHeightPct = cropAspect >= boxAspect ? 100 : (boxAspect / cropAspect) * 100

  // Slide the overflow so the focal point lands where the viewer's eye should.
  // Focus at 0 pins the left/top edge, at 1 the right/bottom — the same
  // arithmetic `object-position` performs on a real page.
  const offsetX = -(innerWidthPct - 100) * focusInCrop.x
  const offsetY = -(innerHeightPct - 100) * focusInCrop.y

  return {
    size: `${sizeX}% ${sizeY}%`,
    position: `${posX}% ${posY}%`,
    innerWidth: `${innerWidthPct}%`,
    innerHeight: `${innerHeightPct}%`,
    offsetX: `${offsetX}%`,
    offsetY: `${offsetY}%`,
  }
}
