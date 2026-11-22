/**
 * Internal page references — dynamic links between CMS pages.
 *
 * A link to another page is stored NOT as a hard-coded URL (`/club`) but as a
 * reference to the target page's stable id (`cms:page:<pageId>`). The publisher
 * resolves the ref to the page's CURRENT public path at publish time, so
 * renaming a page's slug keeps every link pointing at it — no broken links, no
 * manual find-and-replace.
 *
 * Format: `cms:page:<pageId>` with an optional query string and fragment
 *   - `cms:page:abc123`            → `/club`        (or `/` for the home page)
 *   - `cms:page:abc123#features`   → `/club#features`
 *
 * The `cms:` scheme is deliberately not a real URL scheme, so it never escapes
 * to a published page un-resolved; an unresolvable ref degrades to `#`.
 */

import type { Page } from './page'
import { pagePublicPath } from './slugs'

const PAGE_REF_PREFIX = 'cms:page:'

interface ParsedPageRef {
  pageId: string
  /** Includes the leading `?` or `#`, or `''` when absent. */
  suffix: string
}

/** Build a page-reference value for the given page id (+ optional query or fragment). */
export function makePageRef(pageId: string, suffix = ''): string {
  const separator = suffix && !suffix.startsWith('#') && !suffix.startsWith('?') ? '#' : ''
  return `${PAGE_REF_PREFIX}${pageId}${separator}${suffix}`
}

/** Whether a value is a page reference. */
export function isPageRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PAGE_REF_PREFIX)
}

/** Parse a page-reference value into its page id + fragment, or null. */
export function parsePageRef(value: unknown): ParsedPageRef | null {
  if (!isPageRef(value)) return null
  const rest = value.slice(PAGE_REF_PREFIX.length)
  const start = rest.search(/[?#]/)
  return start < 0
    ? { pageId: rest, suffix: '' }
    : { pageId: rest.slice(0, start), suffix: rest.slice(start) }
}

/**
 * Resolve a page-reference value to a concrete public URL path using the site's
 * pages. Returns:
 *   - the resolved path (`/club`, `/`, `/club#features`) when the page exists,
 *   - `'#'` when the ref points at a missing/deleted page (safe no-op),
 *   - `null` when the value is not a page reference at all (caller keeps it).
 */
export function resolvePageRef(
  value: unknown,
  pages: ReadonlyArray<Pick<Page, 'id' | 'slug'>>,
): string | null {
  const parsed = parsePageRef(value)
  if (!parsed) return null
  const page = pages.find((p) => p.id === parsed.pageId)
  if (!page) return '#'
  return `${pagePublicPath(page.slug)}${parsed.suffix}`
}
