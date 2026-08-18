/**
 * Focus area → CSS `object-position`.
 *
 * The published bytes are the CROPPED frame, while the focus area is stored
 * against the ORIGINAL upload (so that re-cropping doesn't silently move it).
 * This is the one place that converts between the two spaces.
 *
 * Only the CENTRE is used: `object-position` names a point, and no combination
 * of it can promise a region of a given size stays visible at an arbitrary
 * container aspect. The stored extent is editorial intent for the crop UI —
 * making it bite at publish time means art-directed per-ratio variants, which
 * is a different feature in the image worker.
 *
 * Returns `null` when the result would be the default `50% 50%`, so an image
 * without an editorial focus emits no inline style at all.
 */
export interface FocusArea {
  x: number
  y: number
  width: number
  height: number
}

export interface CropRectangle {
  x: number
  y: number
  width: number
  height: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function focusObjectPosition(
  focus: FocusArea | null | undefined,
  crop: CropRectangle | null | undefined,
): string | null {
  if (!focus) return null

  // Map the point into the cropped frame. A focal point that sits outside the
  // crop clamps to the nearest edge — the user cropped that part away, so the
  // closest surviving pixel is the honest answer.
  const x = crop && crop.width > 0 ? clamp01((focus.x - crop.x) / crop.width) : clamp01(focus.x)
  const y = crop && crop.height > 0 ? clamp01((focus.y - crop.y) / crop.height) : clamp01(focus.y)

  const px = Math.round(x * 1000) / 10
  const py = Math.round(y * 1000) / 10
  if (px === 50 && py === 50) return null
  return `${px}% ${py}%`
}
