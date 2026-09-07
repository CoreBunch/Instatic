/**
 * Parity gate: the editor canvas preview (`useLoopPreviewItems`) and the
 * engine's `site.pages` loop source MUST produce byte-identical loop items
 * for the same page set — same slug→permalink normalization, same template
 * include/exclude filtering.
 *
 * Both now CONSUME the shared `pageToLoopItem` + `filterPagesForLoop`
 * helpers exported from the `@core/loops` barrel. This test asserts that the
 * engine source (`SitePagesSource.preview`) and the shared helpers the admin
 * canvas hook calls agree, so a future change to the exposed loop-item shape
 * can never silently diverge the canvas preview from the published output.
 */

import { describe, expect, it } from 'bun:test'
import { pageToLoopItem, filterPagesForLoop } from '@core/loops'
import { SitePagesSource } from '@core/loops/sources/sitePages'
import type { Page, SiteDocument } from '@core/page-tree'

const page = (id: string, slug: string, title: string, template?: Page['template']): Page => ({
  id,
  slug,
  title,
  nodes: {},
  rootNodeId: '',
  ...(template ? { template } : {}),
})

const everywhereTpl: Page['template'] = {
  enabled: true,
  target: { kind: 'everywhere' },
  priority: 0,
} as never

const postsTpl: Page['template'] = {
  enabled: true,
  target: { kind: 'postTypes', tableSlugs: ['posts'] },
  priority: 0,
} as never

const PAGES: Page[] = [
  page('a', 'index', 'Home'), // slug 'index' → permalink '/'
  page('b', 'about', 'About'), // no leading slash → '/about'
  page('c', '/contact', 'Contact'), // already-slashed slug → '/contact'
  page('d', 'blog', 'Blog Layout', everywhereTpl), // template page, no table slug
  page('e', 'post', 'Post Template', postsTpl), // template page → templateTableSlug 'posts'
]

const site = (pages: Page[]): SiteDocument => ({ id: 's', pages } as unknown as SiteDocument)

/**
 * Reproduce exactly what the admin canvas hook (`useLoopPreviewItems`) does
 * for `site.pages`: shared filter → slice → shared map. The hook also sorts,
 * but ordering is orthogonal to the loop-item *shape* under test here, and
 * 'definition' order (the default) is the identity sort.
 */
function canvasPath(pages: Page[], filters: Record<string, unknown>, limit: number) {
  return filterPagesForLoop(pages, filters)
    .slice(0, limit)
    .map(pageToLoopItem)
}

describe('site.pages loop-item parity (canvas preview ↔ engine source)', () => {
  it('produces identical loop items with no filters', () => {
    const filters = {}
    const limit = 10
    const enginePreview = SitePagesSource.preview({ site: site(PAGES), filters, limit })
    expect(canvasPath(PAGES, filters, limit)).toEqual(enginePreview)
  })

  it('matches the engine public fetch projection while excluding technical templates)', async () => {
    const filters = {}
    const engineFetch = await SitePagesSource.fetch({
      site: site(PAGES),
      filters,
      orderBy: 'definition',
      direction: 'asc',
      offset: 0,
      limit: 10,
    })
    expect(canvasPath(PAGES, { excludeTemplates: true }, 10)).toEqual(engineFetch.items)
    expect(engineFetch.items.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('agrees on permalink normalization (index → /, bare slug → /slug)', () => {
    const items = canvasPath(PAGES, {}, 10)
    const byId = Object.fromEntries(items.map((i) => [i.id, i.fields.permalink]))
    expect(byId.a).toBe('/')
    expect(byId.b).toBe('/about')
    expect(byId.c).toBe('/contact')
  })

  it('agrees on templateOnly filtering', () => {
    const filters = { templateOnly: true }
    const enginePreview = SitePagesSource.preview({ site: site(PAGES), filters, limit: 10 })
    const canvas = canvasPath(PAGES, filters, 10)
    expect(canvas).toEqual(enginePreview)
    expect(canvas.map((i) => i.id)).toEqual(['d', 'e'])
  })

  it('agrees on excludeTemplates filtering', () => {
    const filters = { excludeTemplates: true }
    const enginePreview = SitePagesSource.preview({ site: site(PAGES), filters, limit: 10 })
    const canvas = canvasPath(PAGES, filters, 10)
    expect(canvas).toEqual(enginePreview)
    expect(canvas.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('exposes templateTableSlug consistently for template pages', () => {
    const items = canvasPath(PAGES, {}, 10)
    const byId = Object.fromEntries(items.map((i) => [i.id, i.fields.templateTableSlug]))
    expect(byId.d).toBeNull() // everywhere layout → no primary table slug
    expect(byId.e).toBe('posts')
    expect(byId.b).toBeNull() // non-template page
  })
})
