/**
 * Page head settings as stored data: tolerant parsing, the page row cell,
 * the write-policy gate, duplication, and the store action.
 */
import '@modules/base'
import { describe, expect, it, beforeEach } from 'bun:test'
import { duplicatePage, parsePageSeo, type Page, type PageSeo, type SiteDocument } from '@core/page-tree'
import { pageFromRow, pageToCells } from '@core/data/pageFromRow'
import { useEditorStore } from '@site/store/store'
import { validatePageWriteDiff } from '../../../server/writePolicy/pageDiff'
import { ForbiddenSiteChangeError } from '../../../server/writePolicy/siteDiff'
import { makeSite } from '../fixtures'

const SEO: PageSeo = {
  description: 'About us',
  canonical: 'https://example.com/about',
  openGraph: { title: 'About', url: 'https://example.com/about' },
  jsonLd: ['{"@type":"Organization"}'],
}

function page(seo?: PageSeo): Page {
  return {
    id: 'page_a',
    slug: 'about',
    title: 'About',
    rootNodeId: 'root',
    nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [], classIds: [] } },
    ...(seo ? { seo } : {}),
  } as Page
}

describe('parsePageSeo', () => {
  it('keeps the valid parts of a damaged value', () => {
    expect(parsePageSeo({
      description: '  Kept  ',
      robots: 42,
      themeColors: [{ color: '#fff' }, { media: 'no colour' }],
      links: [{ rel: 'stylesheet', href: '/x.css' }, { rel: 'preload', href: '/f.woff2' }, { rel: 'alternate', href: '/llms.txt' }],
      meta: [{ attribute: 'http-equiv', name: 'refresh', content: '0' }, { attribute: 'name', name: 'description', content: 'dup' }],
      openGraph: { title: '' },
    })).toEqual({
      description: 'Kept',
      themeColors: [{ color: '#fff' }],
      links: [{ rel: 'alternate', href: '/llms.txt' }],
    })
  })

  it('returns null for nothing usable', () => {
    expect(parsePageSeo(undefined)).toBeNull()
    expect(parsePageSeo({ description: '   ', jsonLd: [] })).toBeNull()
  })
})

describe('page head settings in storage and policy', () => {
  it('round-trips through the page row', () => {
    const cells = pageToCells(page(SEO))
    expect(cells.seo).toEqual(SEO)
    const row = { id: 'page_a', tableId: 'pages', slug: 'about', cells } as Parameters<typeof pageFromRow>[0]
    expect(pageFromRow(row).seo).toEqual(SEO)
    expect(pageToCells(page()).seo).toBeUndefined()
  })

  it('changing them needs the structure capability', () => {
    const change = (from: Page, to: Page, capabilities: Parameters<typeof validatePageWriteDiff>[0]['capabilities']) =>
      validatePageWriteDiff({ previousPages: [from], changedPages: [to], deletedPageIds: new Set(), capabilities })
    expect(() => change(page(), page(SEO), ['site.content.edit', 'site.style.edit'])).toThrow(ForbiddenSiteChangeError)
    expect(() => change(page(SEO), page(), ['site.content.edit'])).toThrow(ForbiddenSiteChangeError)
    expect(() => change(page(), page(SEO), ['site.structure.edit'])).not.toThrow()
  })

  it('a duplicate keeps them, except the original address', () => {
    const site = { ...makeSite(), pages: [page(SEO)] } as SiteDocument
    const copy = duplicatePage(site, 'page_a', 'Copy')
    expect(copy.seo).toEqual({
      description: 'About us',
      openGraph: { title: 'About' },
      jsonLd: ['{"@type":"Organization"}'],
    })
  })
})

describe('setPageSeo', () => {
  beforeEach(() => {
    useEditorStore.getState().loadSite(makeSite())
  })

  it('stores normalised settings and clears them with null or blanks', () => {
    const pageId = useEditorStore.getState().site!.pages[0]!.id
    const current = () => useEditorStore.getState().site!.pages.find((p) => p.id === pageId)!
    useEditorStore.getState().setPageSeo(pageId, { description: '  Hello ', robots: '' })
    expect(current().seo).toEqual({ description: 'Hello' })
    useEditorStore.getState().setPageSeo(pageId, { description: ' ' })
    expect(current().seo).toBeUndefined()
    useEditorStore.getState().setPageSeo(pageId, { robots: 'noindex' })
    useEditorStore.getState().setPageSeo(pageId, null)
    expect(current().seo).toBeUndefined()
  })
})
