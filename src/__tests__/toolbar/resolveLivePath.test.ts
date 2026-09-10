import { describe, expect, it } from 'bun:test'
import { resolveLivePath } from '@site/hooks/useActiveLivePath'
import type { Page } from '@core/page-tree'
import type { LoopItem } from '@core/loops/types'

// Minimal Page fixtures — resolveLivePath only reads id / slug / template.
const page = (id: string, slug: string): Page => ({
  id, slug, title: id, nodes: {}, rootNodeId: '',
} as Page)

const everywhereTemplate = (id: string, slug: string): Page => ({
  id, slug, title: id, nodes: {}, rootNodeId: '',
  template: { enabled: true, target: { kind: 'everywhere' }, priority: 0 },
} as Page)

const postsTemplate = (id: string, slug: string): Page => ({
  id, slug, title: id, nodes: {}, rootNodeId: '',
  template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 },
} as Page)

const row = (id: string, permalink: unknown): LoopItem => ({ id, fields: { permalink } })

describe('resolveLivePath', () => {
  it('returns null when no page is active', () => {
    expect(resolveLivePath({
      activePage: null, isTemplate: false, targetKind: null,
      selection: null, sitePages: null, rows: [],
    })).toBeNull()
  })

  it('maps a regular page to its public path', () => {
    expect(resolveLivePath({
      activePage: page('p', 'about-draft'), isTemplate: false, targetKind: null, pageLivePath: '/de/ueber-uns',
      selection: null, sitePages: null, rows: [],
    })).toBe('/de/ueber-uns')
  })

  it('keeps an offline page without a live link even when its draft has a slug', () => {
    expect(resolveLivePath({ activePage: page('offline', 'about'), isTemplate: false, targetKind: null, selection: null, sitePages: null, rows: [] })).toBeNull()
  })

  it('maps the home page (slug "index") to "/"', () => {
    expect(resolveLivePath({
      activePage: page('home', 'index'), isTemplate: false, targetKind: null, pageLivePath: '/',
      selection: null, sitePages: null, rows: [],
    })).toBe('/')
  })

  it('resolves an Everywhere template to the previewed page, NOT the template slug', () => {
    const tpl = everywhereTemplate('layout', 'global-layout')
    const home = page('home', 'index')
    const about = page('about', 'about')
    // No explicit selection → defaults to the first non-template page (home).
    expect(resolveLivePath({
      activePage: tpl, isTemplate: true, targetKind: 'everywhere',
      selection: null, sitePages: [tpl, home, about], rows: [], pageLivePath: '/',
    })).toBe('/')
    // Explicit selection wins.
    expect(resolveLivePath({
      activePage: tpl, isTemplate: true, targetKind: 'everywhere',
      selection: 'about', sitePages: [tpl, home, about], rows: [], pageLivePath: '/about',
    })).toBe('/about')
  })

  it('returns null for an Everywhere template when there are no real pages to preview', () => {
    const tpl = everywhereTemplate('layout', 'global-layout')
    expect(resolveLivePath({
      activePage: tpl, isTemplate: true, targetKind: 'everywhere',
      selection: null, sitePages: [tpl], rows: [],
    })).toBeNull()
  })

  it('resolves a postTypes template to the previewed row permalink', () => {
    const tpl = postsTemplate('post-tpl', 'post-template')
    const rows = [row('r1', '/blog/first'), row('r2', '/blog/second')]
    // Default → first row.
    expect(resolveLivePath({
      activePage: tpl, isTemplate: true, targetKind: 'postTypes',
      selection: null, sitePages: null, rows,
    })).toBe('/blog/first')
    // Explicit selection wins.
    expect(resolveLivePath({
      activePage: tpl, isTemplate: true, targetKind: 'postTypes',
      selection: 'r2', sitePages: null, rows,
    })).toBe('/blog/second')
  })

  it('returns null for a postTypes template with no published rows or a non-string permalink', () => {
    const tpl = postsTemplate('post-tpl', 'post-template')
    expect(resolveLivePath({
      activePage: tpl, isTemplate: true, targetKind: 'postTypes',
      selection: null, sitePages: null, rows: [],
    })).toBeNull()
    expect(resolveLivePath({
      activePage: tpl, isTemplate: true, targetKind: 'postTypes',
      selection: null, sitePages: null, rows: [row('r1', null)],
    })).toBeNull()
  })
})
