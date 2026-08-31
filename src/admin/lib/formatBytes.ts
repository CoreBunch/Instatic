export type ByteUnit = 'B' | 'KB' | 'MB' | 'GB'

const UNITS: readonly ByteUnit[] = ['B', 'KB', 'MB', 'GB']

interface FormatBytesOptions {
  /** Fraction digits on every unit above bytes. Defaults to 1. */
  decimals?: number
  /** Largest unit to step up to — sizes above it keep scaling that unit. */
  maxUnit?: ByteUnit
}

/**
 * Human-readable file size, binary units (1 KB = 1024 B).
 *
 * One formatter for every admin surface that shows a size: media tiles and
 * the asset viewer, the media picker, the upload queue, the CMS-bundle import
 * preview (`maxUnit: 'MB'`), and the Google Fonts download estimate.
 */
export function formatBytes(
  bytes: number,
  { decimals = 1, maxUnit = 'GB' }: FormatBytesOptions = {},
): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const ceiling = UNITS.indexOf(maxUnit)
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < ceiling) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(decimals)} ${UNITS[unit]}`
}
