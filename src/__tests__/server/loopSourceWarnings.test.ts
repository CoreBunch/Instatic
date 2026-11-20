/**
 * Publish warnings for loops whose source nobody provides.
 *
 * Only a loop the publish renders is worth a warning. The check walks each
 * page the way the publisher does, so these cases must say nothing: a hidden
 * loop, a loop under a hidden parent, a node the page root no longer reaches,
 * and a Visual Component no page uses.
 */
import { describe, expect, it } from 'bun:test'
import type { Page, SiteDocument } from '@core/page-tree'
import { CMS_PUBLISH_WARNING_PAGES_NAMED, CMS_PUBLISH_WARNINGS_LISTED } from '@core/persistence/responseSchemas'
import { unavailableLoopSourceWarnings } from '../../../server/publish/loopSourceWarnings'

const GONE = 'acme.shop.offers'

type Node = Page['nodes'][string]

function node(id: string, moduleId: string, props: Record<string, unknown> = {}, children: string[] = [], hidden = false): Node {
  return { id, moduleId, props, breakpointOverrides: {}, children, classIds: [], ...(hidden ? { hidden: true } : {}) } as Node
}

function loop(id: string, sourceId: string, hidden = false): Node {
  return node(id, 'base.loop', { sourceId }, [], hidden)
}

function page(title: string, nodes: Node[]): Page {
  return {
    id: `page_${title}`, title, slug: title.toLowerCase(), rootNodeId: 'root',
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
  } as Page
}

function site(pages: Page[], visualComponents: unknown[] = []): SiteDocument {
  return { id: 's', pages, visualComponents } as unknown as SiteDocument
}

function component(id: string, name: string, nodes: Node[]) {
  return { id, name, tree: { rootNodeId: 'vc_root', nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])) }, params: [], classIds: [], createdAt: 0 }
}

describe('unavailableLoopSourceWarnings', () => {
  it('names a source nobody provides once, with the pages that render a loop on it', () => {
    const result = unavailableLoopSourceWarnings(site([
      page('Shop', [node('root', 'base.body', {}, ['a', 'b', 'c']), loop('a', GONE), loop('b', GONE), loop('c', 'site.pages')]),
      page('Home', [node('root', 'base.body', {}, ['a']), loop('a', GONE)]),
    ]))
    expect(result).toEqual({
      warnings: [{ kind: 'loop-source-unavailable', sourceId: GONE, pages: ['Shop', 'Home'], pageCount: 2 }],
      warningsTotal: 1,
    })
  })

  it('says nothing about a loop the publish does not render', () => {
    const result = unavailableLoopSourceWarnings(site(
      [
        page('Hidden', [node('root', 'base.body', {}, ['a']), loop('a', GONE, true)]),
        page('Under', [node('root', 'base.body', {}, ['box']), node('box', 'base.container', {}, ['a'], true), loop('a', GONE)]),
        page('Orphan', [node('root', 'base.body', {}, []), loop('a', GONE)]),
        page('Unset', [node('root', 'base.body', {}, ['a']), loop('a', '')]),
      ],
      // A component no page uses.
      [component('vc_unused', 'Unused', [node('vc_root', 'base.container', {}, ['l']), loop('l', GONE)])],
    ))
    expect(result).toEqual({ warnings: [], warningsTotal: 0 })
  })

  it('reports a loop inside a Visual Component under the page that uses it', () => {
    const offers = component('vc_offers', 'Offers', [node('vc_root', 'base.container', {}, ['l']), loop('l', GONE)])
    const result = unavailableLoopSourceWarnings(site(
      [
        page('Home', [node('root', 'base.body', {}, ['ref']), node('ref', 'base.visual-component-ref', { componentId: 'vc_offers' })]),
        page('About', [node('root', 'base.body', {}, [])]),
      ],
      [offers],
    ))
    expect(result.warnings).toEqual([{ kind: 'loop-source-unavailable', sourceId: GONE, pages: ['Home'], pageCount: 1 }])
  })

  it('keeps a source on hundreds of pages to one line, so a second missing source still shows', () => {
    const pages = Array.from({ length: 200 }, (_, i) =>
      page(`P${i}`, [node('root', 'base.body', {}, ['a']), loop('a', GONE)]))
    pages.push(page('Last', [node('root', 'base.body', {}, ['a']), loop('a', 'acme.other.list')]))
    const result = unavailableLoopSourceWarnings(site(pages))
    expect(result.warningsTotal).toBe(2)
    expect(result.warnings).toEqual([
      { kind: 'loop-source-unavailable', sourceId: GONE, pages: ['P0', 'P1', 'P2'], pageCount: 200 },
      { kind: 'loop-source-unavailable', sourceId: 'acme.other.list', pages: ['Last'], pageCount: 1 },
    ])
    expect(result.warnings[0]!.pages).toHaveLength(CMS_PUBLISH_WARNING_PAGES_NAMED)
  })

  it('lists the first few sources and counts them all', () => {
    const pages = Array.from({ length: 25 }, (_, i) =>
      page(`P${i}`, [node('root', 'base.body', {}, ['a']), loop('a', `acme.gone.${i}`)]))
    const result = unavailableLoopSourceWarnings(site(pages))
    expect(result.warnings).toHaveLength(CMS_PUBLISH_WARNINGS_LISTED)
    expect(result.warningsTotal).toBe(25)
  })

  it('answers with no warnings instead of throwing on a document it cannot walk', () => {
    const broken = { id: 's', pages: [{ id: 'p', title: 'Broken', rootNodeId: 'root', nodes: null }], visualComponents: [] }
    expect(unavailableLoopSourceWarnings(broken as unknown as SiteDocument)).toEqual({ warnings: [], warningsTotal: 0 })
  })
})
