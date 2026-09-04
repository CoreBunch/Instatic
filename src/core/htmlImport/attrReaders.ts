/**
 * Tiny shared attribute readers for the import rule table and the instatic
 * dialect mapping — one place for the "missing attribute" and numeric
 * coercion conventions so every rule reads attributes the same way.
 */

/** The attribute's value, or `''` when absent. */
export function attr(el: Element, name: string): string {
  return el.getAttribute(name) ?? ''
}

/** The attribute's value trimmed + lowercased, or `''` when absent. */
export function normalizedAttr(el: Element, name: string): string {
  return attr(el, name).trim().toLowerCase()
}

/** The attribute parsed as a finite number, or `fallback`. */
export function numberAttr(el: Element, name: string, fallback: number = 0): number {
  const raw = attr(el, name).trim()
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

/** The attribute as a floored integer clamped to `min`, or `fallback`. */
export function integerAttr(el: Element, name: string, fallback: number, min: number): number {
  return Math.max(min, Math.floor(numberAttr(el, name, fallback)))
}
