interface SlugifyOptions {
  /** Character joining the alphanumeric runs. Defaults to `-`. */
  sep?: string
  /** Returned when the value contains no alphanumerics. Defaults to `''`. */
  fallback?: string
}

/**
 * Lower-case an arbitrary label and collapse every non-alphanumeric run into
 * a single separator, with no leading or trailing separator.
 *
 * Used for values that get persisted (data-table names, field ids, site item
 * slugs), so the shape is deliberately ASCII-only: anything outside `a-z0-9`
 * — accents included — is a separator, never transliterated.
 *
 * For post/page titles use `slugFromTitle` from `@core/utils/slug` instead:
 * it additionally drops quotes so `"Don't"` becomes `dont`, not `don-t`.
 */
export function slugify(value: string, { sep = '-', fallback = '' }: SlugifyOptions = {}): string {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(sep) || fallback
}
