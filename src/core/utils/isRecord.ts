/** A plain object (not null, not an array): the shape guard for loose JSON before a schema takes over. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
