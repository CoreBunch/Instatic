/**
 * Constrain `value` to `[min, max]`. Non-finite input (`NaN`, `±Infinity`)
 * collapses to `min` rather than propagating — every caller here feeds the
 * result into a CSS value or a slider position, where `NaN` renders as a
 * silently broken layout instead of an error.
 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}
