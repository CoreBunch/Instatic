import { describe, expect, it } from 'bun:test'
import { buildSiteAgentSnapshot } from '@site/agent/siteAgentSnapshot'
import type { SiteDocument, Page } from '@core/page-tree'

function fixture(): { site: SiteDocument; active: Page } {
  const active = {
    id: 'p1',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root',
    nodes: { root: { id: 'root', moduleId: 'base.body', children: [], props: {} } },
  } as unknown as Page
  const other = {
    id: 'p2',
    title: 'About',
    slug: 'about',
    rootNodeId: 'r2',
    nodes: { r2: { id: 'r2', moduleId: 'base.body', children: [], props: {} } },
  } as unknown as Page
  const site = {
    pages: [active, other],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1280, icon: 'i' }],
    styleRules: {},
    settings: { framework: {}, fonts: {} },
    visualComponents: [],
  } as unknown as SiteDocument
  return { site, active }
}

describe('buildSiteAgentSnapshot', () => {
  it('keeps the selected language but excludes sparse drafts for other languages', () => {
    const { site, active } = fixture()
    site.localeId = 'de'
    site.localization = { fieldLocalizations: {}, rows: {} }
    const snap = buildSiteAgentSnapshot(active, site, {
      selectedNodeId: null, activeBreakpointId: 'desktop', currentDocument: { type: 'page', id: active.id },
    })
    expect(snap.site.localeId).toBe('de')
    expect(Object.hasOwn(snap.site, 'localization')).toBe(false)
  })
  it('posts the active page with full nodes', () => {
    const { site, active } = fixture()
    const snap = buildSiteAgentSnapshot(active, site, {
      selectedNodeId: 'root',
      activeBreakpointId: 'desktop',
      currentDocument: { type: 'page', id: active.id },
    })
    expect(snap.page.id).toBe('p1')
    expect(snap.currentDocument).toEqual({ type: 'page', id: 'p1' })
    expect(Object.keys(snap.page.nodes)).toEqual(['root'])
    expect(snap.selectedNodeId).toBe('root')
    expect(snap.activeBreakpointId).toBe('desktop')
  })

  it("strips non-active pages' nodes to keep the payload bounded", () => {
    const { site, active } = fixture()
    const snap = buildSiteAgentSnapshot(active, site, {
      selectedNodeId: null,
      activeBreakpointId: 'desktop',
      currentDocument: { type: 'page', id: active.id },
    })
    const other = snap.site.pages.find((p) => p.id === 'p2')!
    expect(other.title).toBe('About')
    expect(Object.keys(other.nodes)).toEqual([]) // emptied
    const activeInSite = snap.site.pages.find((p) => p.id === 'p1')!
    expect(Object.keys(activeInSite.nodes)).toEqual(['root']) // active intact
  })

  it('preserves site-level styleRules and settings', () => {
    const { site, active } = fixture()
    const snap = buildSiteAgentSnapshot(active, site, {
      selectedNodeId: null,
      activeBreakpointId: 'desktop',
      currentDocument: { type: 'page', id: active.id },
    })
    expect(snap.site.styleRules).toBeDefined()
    expect(snap.site.settings).toBeDefined()
    expect(snap.site.breakpoints).toHaveLength(1)
  })
})
