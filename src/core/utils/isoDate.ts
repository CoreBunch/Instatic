export function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
export function isoDateOrNull(value: Date | string | null | undefined): string | null {
  return value == null ? null : isoDate(value)
}

/**
 * The current time as ISO 8601 text, to bind into a timestamp column the
 * admin parses and displays. SQL `current_timestamp` is not that: SQLite's
 * is a space-separated UTC string that `Date.parse` reads as LOCAL time,
 * which showed a branch merged a second ago as "updated 2h ago". Postgres
 * `timestamptz` accepts the same text.
 */
export function nowIso(): string {
  return new Date().toISOString()
}
