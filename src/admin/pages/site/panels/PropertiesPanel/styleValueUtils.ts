/**
 * Shared "is this CSS property set?" helpers used across PropertiesPanel
 * sections. Single source of truth for the trio of treatments we apply to
 * raw style cells — "set" means a non-empty string or any number, anything
 * else (undefined, null, empty string) is treated as unset.
 */

/**
 * Read a property from a styles bag, returning the value only if it is a
 * non-empty string. Numbers, undefined, null, and empty strings collapse to
 * `undefined` so callers can keep their conditionals concise.
 */
export function readString(styles: Record<string, unknown>, key: string): string | undefined {
  const v = styles[key]
  if (typeof v === 'string' && v !== '') return v
  return undefined
}

/**
 * Narrow check: returns true when the given value would render as a real CSS
 * value (a non-empty string or any number). Empty string is treated as unset
 * so we mirror the storage model used by `removeClassStyleProperty`.
 */
export function hasStyleValue(value: unknown): value is string | number {
  return value !== undefined && value !== null && value !== ''
}

/**
 * Bump the numeric part of a CSS length, leaving the unit untouched:
 * `80%` + 1 → `81%`, `4px` − 1 → `3px`, `1.5rem` + 1 → `2.5rem`.
 *
 * Returns undefined for values with no numeric part (`auto`, `fit-content`,
 * `var(--space-l)`) — a stepper must not turn a keyword into a number. A bare
 * number gains `px`, the unit a bare CSS length would have meant anyway.
 *
 * `delta` is any integer, not just ±1: a Shift-drag steps by ten, and a fast
 * scrub crosses several steps between two pointer events.
 */
const NUMERIC_LENGTH_RE = /^(-?\d*\.?\d+)([a-z%]*)$/i

export function stepCssLength(
  value: string,
  delta: number,
  { min = 0 }: { min?: number } = {},
): string | undefined {
  const match = NUMERIC_LENGTH_RE.exec(value.trim())
  if (!match) return undefined
  const next = Math.max(min, Math.round((Number(match[1]) + delta) * 100) / 100)
  return `${next}${match[2] || 'px'}`
}
