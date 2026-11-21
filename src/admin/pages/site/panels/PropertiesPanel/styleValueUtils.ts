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
 * so we mirror the storage model used by `clearClassStyleProperties`.
 */
export function hasStyleValue(value: unknown): value is string | number {
  return value !== undefined && value !== null && value !== ''
}
