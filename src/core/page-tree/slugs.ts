import type { Page } from './page'
import { isReservedPublicPath } from '../publicPaths'

export function normalizePageSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split('/')
    .map(normalizePageSlugSegment)
    .filter(Boolean)
    .join('/')
}

export function pageSlugError(slug: string): string | null {
  if (!slug) return 'Page slug is required.'
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(slug)) {
    return 'Page slug must use lowercase letters, numbers, single hyphens, and optional single slashes.'
  }
  const firstSegment = slug.split('/')[0] ?? slug
  if (isReservedPublicPath(firstSegment)) {
    return firstSegment === slug
      ? `Page slug "${slug}" is reserved.`
      : `Page slug path cannot start with "${firstSegment}".`
  }
  return null
}

export function pageSlugDuplicateError(
  slug: string,
  pages: Page[],
  currentPageId?: string,
): string | null {
  const duplicate = pages.find((page) =>
    page.slug === slug && page.id !== currentPageId
  )
  return duplicate ? `Duplicate page slug "/${slug}".` : null
}

/**
 * Make a desired slug unique within `pages` by auto-suffixing (`-2`, `-3`, …).
 * Used by the page-creation mutations (addPage / duplicatePage) and by
 * renamePage so two pages can never collide on a slug — a collision makes the
 * whole site fail `validateSite` on save. `excludePageId` skips the page being
 * renamed so re-saving its own slug is a no-op rather than a self-collision.
 */
export function uniquePageSlug(
  desired: string,
  pages: Page[],
  excludePageId?: string,
): string {
  const base = validPageSlugBase(normalizePageSlug(desired) || 'page')
  let candidate = base
  let suffix = 2
  while (pageSlugError(candidate) || pages.some((page) => page.slug === candidate && page.id !== excludePageId)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

export function createUniquePageSlug(title: string, pages: Page[]): string {
  const normalized = normalizePageSlug(title)
  const base = !normalized
    ? 'page'
    : pageSlugError(normalized)
      ? validPageSlugBase(normalized)
      : normalized
  let candidate = base
  let suffix = 2
  while (pageSlugError(candidate) || pages.some((page) => page.slug === candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

export function pagePublicPath(slug: string): string {
  return slug === 'index' ? '/' : `/${slug}`
}

/** The home page is the one published at the site root (`/`) — slug `index`. */
export function isHomePage(page: Page): boolean {
  return page.slug === 'index'
}

/**
 * Resolve the site's home page (slug `index`). Used as the default selection
 * when the editor opens without an explicit page in the URL, and to pin the
 * home page to the top of the site explorer's page list.
 */
export function findHomePage(pages: Page[]): Page | undefined {
  return pages.find(isHomePage)
}

function normalizePageSlugSegment(value: string): string {
  return value
    .trim()
    .replace(/['"]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function validPageSlugBase(slug: string): string {
  const [firstSegment = '', ...rest] = slug.split('/')
  if (!isReservedPublicPath(firstSegment)) return slug
  return [`${firstSegment}-page`, ...rest].filter(Boolean).join('/')
}
