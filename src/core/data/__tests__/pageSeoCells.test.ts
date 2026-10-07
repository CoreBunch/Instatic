import { describe, expect, it } from 'bun:test'
import { pageFromRow, pageToCells } from '../pageFromRow'
import { readPageSeoCells, writePageSeoCells } from '../pageSeoCells'
import { duplicatePage, PageSeoValidationError, type PageSeo } from '@core/page-tree'
import { makePage, makeSite } from '../../../__tests__/fixtures'
import type { DataRow } from '../schemas'

const seo: PageSeo = {
  title: 'Page SEO', description: 'Page description', canonical: '/canonical',
  alternates: [{ id: 'fr', language: 'fr-CA', href: '/fr' }],
  meta: [{ id: 'og', attribute: 'property', key: 'og:title', content: 'Page SEO' }],
  links: [{ id: 'manifest', rel: 'manifest', href: '/manifest.json' }],
  structuredData: [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', name: 'Name' }] }],
}
const row = (cells: Record<string, unknown>): DataRow => ({ id: 'p1', slug: 'index', tableId: 'pages', cells,
  status: 'draft', authorUserId: null, createdByUserId: null, updatedByUserId: null, publishedByUserId: null,
  author: null, createdBy: null, updatedBy: null, publishedBy: null,
  createdAt: '', updatedAt: '', publishedAt: null, scheduledPublishAt: null, deletedAt: null,
})

describe('page SEO native cells', () => {
  it('round-trips ordinary URL/repeater/text fields without changing the display title', () => {
    const page = makePage({ id: 'p1', title: 'Display title' })
    page.seo = seo
    const cells = pageToCells(page)
    expect(cells.seoAlternates).toEqual([{ id: 'fr', cells: { language: 'fr-CA', href: '/fr' } }])
    expect(typeof cells.seoStructuredData).toBe('string')
    const loaded = pageFromRow(row(cells))
    expect(loaded.seo).toEqual(seo)
    expect(loaded.title).toBe('Display title')
  })
  it('reads existing authored SEO cells and clears every native field explicitly', () => {
    expect(readPageSeoCells({ seoTitle: 'Existing', seoDescription: 'Existing description' })).toEqual({ title: 'Existing', description: 'Existing description' })
    const cleared = writePageSeoCells(undefined)
    expect(cleared).toEqual({ seoTitle: '', seoDescription: '', seoCanonical: '', seoAlternates: [], seoMeta: [], seoLinks: [], seoStructuredData: '' })
    expect(readPageSeoCells(cleared)).toBeUndefined()
  })
  it('reports malformed native metadata rather than dropping source data', () => {
    for (const cells of [
      { seoTitle: 42 }, { seoCanonical: 'mailto:admin@example.com' },
      { seoAlternates: [{ id: 'fr', cells: { href: '/fr' } }] },
      { seoStructuredData: '[invalid JSON' }, { seoStructuredData: '[1,2]' },
    ]) expect(() => readPageSeoCells(cells)).toThrow(PageSeoValidationError)
  })
  it('accepts nullable optional text cells from the native repeater editor', () => {
    expect(readPageSeoCells({
      seoMeta: [{ id: 'robots', cells: { attribute: 'name', key: 'robots', content: null, media: null } }],
      seoLinks: [{ id: 'icon', cells: { rel: 'icon', href: '/icon.svg', type: null, sizes: null, media: null } }],
    })).toEqual({
      meta: [{ id: 'robots', attribute: 'name', key: 'robots', content: '' }],
      links: [{ id: 'icon', rel: 'icon', href: '/icon.svg' }],
    })
  })
  it('deep-clones authored metadata when a page is duplicated', () => {
    const page = makePage({ id: 'p1' })
    page.seo = structuredClone(seo)
    const site = makeSite({ pages: [page] })
    const copy = duplicatePage(site, 'p1', 'Copy')
    expect(copy.seo).toEqual(seo)
    copy.seo!.links![0].href = '/other-manifest.json'
    expect(page.seo.links![0].href).toBe('/manifest.json')
  })
})
