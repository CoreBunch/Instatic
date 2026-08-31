/**
 * Locale-formatted timestamps for admin surfaces.
 *
 * Defaults to the browser's full date + time (`toLocaleString()`); pass
 * `Intl.DateTimeFormatOptions` when a surface wants a narrower shape (the
 * schedule dialog and the data-row inspector both use the abbreviated
 * `year / short month / day / 2-digit time` form).
 *
 * An unparseable value is returned verbatim rather than rendered as the
 * browser's `"Invalid Date"` string.
 */
export function formatDateTime(value: string, options?: Intl.DateTimeFormatOptions): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, options)
}

/** The abbreviated shape used by the plugin schedules dialog and row inspector. */
export const SHORT_DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}
