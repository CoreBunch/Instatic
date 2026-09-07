/**
 * Internal page references — dynamic links between CMS pages.
 *
 * A link to another page is stored NOT as a hard-coded URL (`/club`) but as a
 * reference to the target page's stable id (`cms:page:<pageId>`). The publisher
 * resolves the ref to the page's CURRENT public path at publish time, so
 * renaming a page's slug keeps every link pointing at it — no broken links, no
 * manual find-and-replace.
 *
 * Format: `cms:page:<pageId>` with an optional trailing `#fragment`
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
  /** Includes the leading `#`, or `''` when absent. */
  fragment: string
}

/** Build a page-reference value for the given page id (+ optional fragment). */
export function makePageRef(pageId: string, fragment?: string): string {
  if (!fragment) return `${PAGE_REF_PREFIX}${pageId}`
  const frag = fragment.startsWith('#') ? fragment : `#${fragment}`
  return `${PAGE_REF_PREFIX}${pageId}${frag}`
}

/** Whether a value is a page reference. */
export function isPageRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PAGE_REF_PREFIX)
}

/** Parse a page-reference value into its page id + fragment, or null. */
export function parsePageRef(value: unknown): ParsedPageRef | null {
  if (!isPageRef(value)) return null
  const rest = value.slice(PAGE_REF_PREFIX.length)
  const hashIdx = rest.indexOf('#')
  if (hashIdx === -1) return { pageId: rest, fragment: '' }
  return { pageId: rest.slice(0, hashIdx), fragment: rest.slice(hashIdx) }
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
  pages: ReadonlyArray<Pick<Page, 'id' | 'slug' | 'publicPath'>>,
): string | null {
  const parsed = parsePageRef(value)
  if (!parsed) return null
  const page = pages.find((p) => p.id === parsed.pageId)
  if (!page) return '#'
  return `${page.publicPath ?? pagePublicPath(page.slug)}${parsed.fragment}`
}
