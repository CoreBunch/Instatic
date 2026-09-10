/**
 * Built-in `site.pages` loop source — iterates pages from the active site
 * document.
 *
 * Operates against the in-memory site document rather than the DB:
 * publisher snapshots are loaded into a SiteDocument before render, and
 * the page list is just `site.pages`. No I/O needed.
 *
 * Filters:
 *   - templateOnly — when true, only pages with `template.enabled` are
 *     returned (handy for an admin-style "list of templates" loop).
 *   - excludeTemplates — when true, skips template pages so a "site
 *     navigation" loop doesn't accidentally include them.
 *
 * Order options:
 *   - title         — alphabetical
 *   - slug          — URL-stable order
 *   - definition    — order they appear in `site.pages` (insertion order)
 */

import type { LoopEntitySource, LoopFetchResult, LoopItem } from '@core/loops/types'
import type { Page } from '@core/page-tree'
import { primaryTemplateTableSlug } from '@core/templates'

/**
 * Project a page into the loop-item field bag (slug → permalink
 * normalization + the exposed fields). This is the single source of truth
 * for the `site.pages` loop item shape — both the publisher (via this
 * source's `fetch`/`preview`) and the editor canvas preview
 * (`useLoopPreviewItems`) import it through the `@core/loops` barrel so the
 * canvas and the published output can never silently disagree.
 */
export function pageToLoopItem(page: Page): LoopItem {
  const slug = page.slug.startsWith('/') ? page.slug : `/${page.slug}`
  const permalink = page.template?.enabled === true ? '' : page.publicPath ?? (slug === '/index' ? '/' : slug)
  return {
    id: page.id,
    fields: {
      id: page.id,
      title: page.title,
      slug: page.slug,
      permalink,
      isTemplate: page.template?.enabled === true,
      templateTableSlug: primaryTemplateTableSlug(page),
    },
  }
}

/**
 * Apply the `templateOnly` / `excludeTemplates` include-exclude filter for
 * `site.pages` loops. Shared with the editor canvas preview so template
 * filtering matches between canvas and published output.
 */
export function filterPagesForLoop(
  pages: readonly Page[],
  filters: Record<string, unknown>,
): Page[] {
  const templateOnly = filters.templateOnly === true
  const excludeTemplates = filters.excludeTemplates === true

  return pages.filter((page) => {
    const isTemplate = page.template?.enabled === true
    if (templateOnly && !isTemplate) return false
    if (excludeTemplates && isTemplate) return false
    return true
  })
}

function compare(a: Page, b: Page, orderBy: string, direction: 'asc' | 'desc'): number {
  const sign = direction === 'asc' ? 1 : -1
  if (orderBy === 'title') return sign * a.title.localeCompare(b.title)
  if (orderBy === 'slug') return sign * a.slug.localeCompare(b.slug)
  // definition / fallback — stable order; caller must pre-sort by index
  return 0
}

export const SitePagesSource: LoopEntitySource = {
  id: 'site.pages',
  label: 'Site pages',
  description: 'Loop pages from the current site document — useful for nav menus and sitemaps.',

  filterSchema: {
    excludeTemplates: {
      type: 'toggle',
      label: 'Exclude template pages',
    },
    templateOnly: {
      type: 'toggle',
      label: 'Only template pages',
    },
  },

  orderByOptions: [
    { id: 'definition', label: 'Definition order' },
    { id: 'title', label: 'Title' },
    { id: 'slug', label: 'Slug' },
  ],

  fields: [
    { id: 'title', label: 'Title' },
    { id: 'slug', label: 'Slug' },
    { id: 'permalink', label: 'Permalink', format: 'url' },
  ],

  async fetch(ctx): Promise<LoopFetchResult> {
    const filtered = filterPagesForLoop(ctx.site.pages.filter((page) => page.template?.enabled !== true), ctx.filters)
    const sorted =
      ctx.orderBy === 'title' || ctx.orderBy === 'slug'
        ? [...filtered].sort((a, b) => compare(a, b, ctx.orderBy, ctx.direction))
        : ctx.direction === 'desc'
          ? [...filtered].reverse()
          : filtered

    const sliced = sorted.slice(ctx.offset, ctx.offset + ctx.limit)
    return {
      items: sliced.map(pageToLoopItem),
      totalItems: filtered.length,
    }
  },

  preview(ctx) {
    const filtered = filterPagesForLoop(ctx.site.pages, ctx.filters)
    return filtered.slice(0, ctx.limit).map(pageToLoopItem)
  },
}
