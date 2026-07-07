/**
 * Page-level mutation tests — addPage, deletePage, renamePage, reorderPages
 *
 * These functions operate on a `SiteDocument` draft (not a single `Page`).
 * They were at 0% coverage after the initial scaffold.
 * Required before J5 (canvas) ships — the site store calls these.
 */

import { describe, it, expect } from 'bun:test'
import { create } from 'mutative'
import type { SiteDocument } from '@core/page-tree'
import {
  addPage,
  normalizePageSlug,
  pagePublicPath,
  pageSlugError,
  deletePage,
  renamePage,
  reorderPages,
} from '@core/page-tree'
import { createUniquePageSlug } from '@core/page-tree'
import { makeSite, makePage } from '../fixtures'

// ---------------------------------------------------------------------------
// addPage
// ---------------------------------------------------------------------------

describe('addPage', () => {
  it('adds a new page to the site', () => {
    const site = makeSite({ pages: [makePage()] })
    addPage(site, 'About', 'about')
    expect(site.pages).toHaveLength(2)
  })

  it('returns the newly created Page', () => {
    const site = makeSite({ pages: [] })
    const page = addPage(site, 'Contact', 'contact')
    expect(page.title).toBe('Contact')
    expect(page.slug).toBe('contact')
    expect(page.rootNodeId).toBeTruthy()
    expect(Object.keys(page.nodes)).toHaveLength(1) // root node only
  })

  it('slug is lowercased and sanitised', () => {
    const site = makeSite({ pages: [] })
    const page = addPage(site, 'Our Services', 'Our Services Page!')
    // Special chars removed, spaces → dashes, lowercased
    expect(page.slug).not.toContain(' ')
    expect(page.slug).not.toContain('!')
    expect(page.slug).toBe(page.slug.toLowerCase())
  })

  it('preserves safe slash-delimited page paths', () => {
    const site = makeSite({ pages: [] })
    const page = addPage(site, 'Quick Start', 'Guides/Quick Start')
    expect(page.slug).toBe('guides/quick-start')
    expect(pagePublicPath(page.slug)).toBe('/guides/quick-start')
  })

  it('creates a unique root node for each page', () => {
    const site = makeSite({ pages: [] })
    const p1 = addPage(site, 'Home', 'index')
    const p2 = addPage(site, 'About', 'about')
    expect(p1.rootNodeId).not.toBe(p2.rootNodeId)
  })

  it('root node is in the page nodes map', () => {
    const site = makeSite({ pages: [] })
    const page = addPage(site, 'Home', 'index')
    expect(page.nodes[page.rootNodeId]).toBeDefined()
    expect(page.nodes[page.rootNodeId].moduleId).toBe('base.body')
  })

  it('page is added at the end of site.pages array', () => {
    const site = makeSite({ pages: [makePage({ slug: 'existing' })] })
    addPage(site, 'New', 'new-page')
    expect(site.pages[site.pages.length - 1].slug).toBe('new-page')
  })

  it('generates slugs that avoid reserved public routes', () => {
    const site = makeSite({ pages: [] })
    expect(createUniquePageSlug('Admin', site.pages)).toBe('admin-page')
  })

  it('generates nested slugs from slash-delimited titles', () => {
    const site = makeSite({ pages: [] })
    expect(createUniquePageSlug('Docs/API Reference', site.pages)).toBe('docs/api-reference')
  })

  it('generates slugs that avoid existing page slugs', () => {
    const site = makeSite({ pages: [makePage({ slug: 'about' })] })
    expect(createUniquePageSlug('About', site.pages)).toBe('about-2')
  })

  it('is Mutative-safe — create() works with addPage', () => {
    const site = makeSite({ pages: [makePage()] })
    const originalCount = site.pages.length

    const nextSite = create(site, (draft) => {
      addPage(draft, 'Mutative Test', 'mutative-test')
    })

    expect(site.pages).toHaveLength(originalCount) // original unchanged
    expect(nextSite.pages).toHaveLength(originalCount + 1)
  })

  it('auto-suffixes a colliding slug so a repeated create never duplicates', () => {
    const site = makeSite({ pages: [] })
    const first = addPage(site, 'Main Template', 'main-template')
    const second = addPage(site, 'Main Template', 'main-template')
    const third = addPage(site, 'Main Template', 'main-template')
    expect(first.slug).toBe('main-template')
    expect(second.slug).toBe('main-template-2')
    expect(third.slug).toBe('main-template-3')
    // No two pages share a slug — the site stays save-valid.
    const slugs = site.pages.map((p) => p.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})

describe('page slugs', () => {
  it('normalizes each slash-delimited path segment', () => {
    expect(normalizePageSlug(' Docs / API Reference / ')).toBe('docs/api-reference')
  })

  it('accepts safe slash-delimited public paths', () => {
    expect(pageSlugError('docs/api-reference')).toBeNull()
  })

  it('rejects empty path segments', () => {
    expect(pageSlugError('docs//api')).toBe('Page slug must use lowercase letters, numbers, single hyphens, and optional single slashes.')
  })
})

// ---------------------------------------------------------------------------
// deletePage
// ---------------------------------------------------------------------------

describe('deletePage', () => {
  it('removes a page by id', () => {
    const pageA = makePage({ id: 'page-a', slug: 'a' })
    const pageB = makePage({ id: 'page-b', slug: 'b' })
    const site = makeSite({ pages: [pageA, pageB] })

    deletePage(site, 'page-a')
    expect(site.pages).toHaveLength(1)
    expect(site.pages[0].id).toBe('page-b')
  })

  it('throws when trying to delete the last page', () => {
    const site = makeSite({ pages: [makePage()] })
    expect(() => deletePage(site, site.pages[0].id)).toThrow()
  })

  it('is a no-op for non-existent page id (does not throw)', () => {
    const site = makeSite({ pages: [makePage(), makePage({ id: 'page-2', slug: 'b' })] })
    expect(() => deletePage(site, 'nonexistent-id')).not.toThrow()
    expect(site.pages).toHaveLength(2)
  })

  it('is Mutative-safe', () => {
    const p1 = makePage({ id: 'p1', slug: 'p1' })
    const p2 = makePage({ id: 'p2', slug: 'p2' })
    const site = makeSite({ pages: [p1, p2] })

    const nextSite = create(site, (draft) => {
      deletePage(draft, 'p1')
    })

    expect(site.pages).toHaveLength(2) // original unchanged
    expect(nextSite.pages).toHaveLength(1)
    expect(nextSite.pages[0].id).toBe('p2')
  })
})

// ---------------------------------------------------------------------------
// renamePage
// ---------------------------------------------------------------------------

describe('renamePage', () => {
  it('updates the page title', () => {
    const page = makePage({ id: 'page-1', title: 'Old Title' })
    const site = makeSite({ pages: [page] })

    renamePage(site, 'page-1', 'New Title')
    expect(site.pages[0].title).toBe('New Title')
  })

  it('throws when page does not exist', () => {
    const site = makeSite({ pages: [makePage()] })
    expect(() => renamePage(site, 'nonexistent', 'Title')).toThrow()
  })

  it('accepts an empty title (edge case — validation is UI responsibility)', () => {
    const page = makePage({ id: 'p1' })
    const site = makeSite({ pages: [page] })
    expect(() => renamePage(site, 'p1', '')).not.toThrow()
    expect(site.pages[0].title).toBe('')
  })

  it('is Mutative-safe', () => {
    const page = makePage({ id: 'p1', title: 'Original' })
    const site = makeSite({ pages: [page] })

    const nextSite = create(site, (draft) => {
      renamePage(draft, 'p1', 'Updated')
    })

    expect(site.pages[0].title).toBe('Original') // original unchanged
    expect(nextSite.pages[0].title).toBe('Updated')
  })

  it('auto-suffixes a slug that collides with another page', () => {
    const site = makeSite({
      pages: [makePage({ id: 'a', slug: 'about' }), makePage({ id: 'b', slug: 'b' })],
    })
    renamePage(site, 'b', 'About', 'about')
    expect(site.pages.find((p) => p.id === 'b')!.slug).toBe('about-2')
  })

  it('keeps the page own slug stable when renaming title only', () => {
    const site = makeSite({ pages: [makePage({ id: 'a', slug: 'about' })] })
    renamePage(site, 'a', 'About Us', 'about')
    // Re-setting its own slug must not self-collide into about-2.
    expect(site.pages[0].slug).toBe('about')
  })

  it('sets slug "index" verbatim (homepage intent), not deduped', () => {
    const site = makeSite({ pages: [makePage({ id: 'a', slug: 'landing' })] })
    renamePage(site, 'a', 'Home', 'index')
    expect(site.pages[0].slug).toBe('index')
  })
})

// ---------------------------------------------------------------------------
// reorderPages
// ---------------------------------------------------------------------------

describe('reorderPages', () => {
  function makeSiteWithPages(ids: string[]): SiteDocument {
    const pages = ids.map((id) => makePage({ id, slug: id }))
    return makeSite({ pages })
  }

  it('moves a page from one index to another', () => {
    const site = makeSiteWithPages(['a', 'b', 'c'])
    reorderPages(site, 0, 2) // move 'a' to end
    expect(site.pages.map((p) => p.id)).toEqual(['b', 'c', 'a'])
  })

  it('moves a page to the beginning', () => {
    const site = makeSiteWithPages(['a', 'b', 'c'])
    reorderPages(site, 2, 0) // move 'c' to front
    expect(site.pages.map((p) => p.id)).toEqual(['c', 'a', 'b'])
  })

  it('reordering adjacent pages works correctly', () => {
    const site = makeSiteWithPages(['a', 'b', 'c'])
    reorderPages(site, 0, 1) // swap first two
    expect(site.pages.map((p) => p.id)).toEqual(['b', 'a', 'c'])
  })

  it('reordering from same index to same index is a no-op', () => {
    const site = makeSiteWithPages(['a', 'b', 'c'])
    reorderPages(site, 1, 1)
    expect(site.pages.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('is Mutative-safe', () => {
    const site = makeSiteWithPages(['a', 'b', 'c'])

    const nextSite = create(site, (draft) => {
      reorderPages(draft, 0, 2)
    })

    expect(site.pages.map((p) => p.id)).toEqual(['a', 'b', 'c']) // unchanged
    expect(nextSite.pages.map((p) => p.id)).toEqual(['b', 'c', 'a'])
  })
})
