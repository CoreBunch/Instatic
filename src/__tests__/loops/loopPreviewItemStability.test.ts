/**
 * selectSitePagesLoopItems — identity stability for canvas loop previews.
 *
 * Any node edit anywhere replaces the `site.pages` array identity (pages own
 * nodes under Mutative structural sharing), so a `site.pages`-bound loop's
 * selector re-runs per keystroke. The contract under test: when the loop's
 * actual items are unchanged, the selector returns the PREVIOUS array (and
 * the previous LoopItem objects), so `CanvasTemplateContext` values stay
 * stable and the loop body subtree does not re-render.
 */

import { describe, it, expect } from 'bun:test'
import type { Page, PageNode } from '@core/page-tree'
import { selectSitePagesLoopItems } from '@site/canvas/useLoopPreviewItems'

function makePage(id: string, title: string, slug: string): Page {
  return {
    id,
    title,
    slug,
    nodes: {},
    rootNodeId: 'root',
  } as unknown as Page
}

function makeLoopNode(props: Record<string, unknown> = {}): PageNode {
  return {
    id: `loop-${Math.random().toString(36).slice(2)}`,
    moduleId: 'base.loop',
    // direction defaults to 'desc' in readLoopProps; pin 'asc' so the
    // definition-order assertions below read naturally.
    props: { sourceId: 'site.pages', direction: 'asc', ...props },
    breakpointOverrides: {},
    children: ['variant'],
  } as unknown as PageNode
}

describe('selectSitePagesLoopItems', () => {
  it('returns the cached array for the same (node, pages) identities', () => {
    const node = makeLoopNode()
    const pages = [makePage('a', 'A', 'a'), makePage('b', 'B', 'b')]

    const first = selectSitePagesLoopItems(node, pages)
    expect(first.map((i) => i.id)).toEqual(['a', 'b'])
    // A selector sweep re-runs this on every store set with unchanged state.
    for (let i = 0; i < 20; i++) {
      expect(selectSitePagesLoopItems(node, pages)).toBe(first)
    }
  })

  it('keeps the array identity when pages identity changes but the items do not', () => {
    const node = makeLoopNode()
    const pageA = makePage('a', 'A', 'a')
    const pageB = makePage('b', 'B', 'b')

    const first = selectSitePagesLoopItems(node, [pageA, pageB])
    // Unrelated edit: Mutative replaces the array but reuses untouched pages.
    const second = selectSitePagesLoopItems(node, [pageA, pageB])
    expect(second).toBe(first)
  })

  it('keeps untouched item identities when one page actually changes', () => {
    const node = makeLoopNode()
    const pageA = makePage('a', 'A', 'a')
    const pageB = makePage('b', 'B', 'b')
    const first = selectSitePagesLoopItems(node, [pageA, pageB])

    const editedB = makePage('b', 'B edited', 'b')
    const second = selectSitePagesLoopItems(node, [pageA, editedB])

    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0]) // untouched page → same LoopItem
    expect(second[1]).not.toBe(first[1])
    expect(second[1].fields.title).toBe('B edited')
  })

  it('recomputes when the loop node itself changes (new props → new node identity)', () => {
    const pages = [makePage('a', 'A', 'a'), makePage('b', 'B', 'b'), makePage('c', 'C', 'c')]
    const all = selectSitePagesLoopItems(makeLoopNode(), pages)
    expect(all).toHaveLength(3)

    const limited = selectSitePagesLoopItems(makeLoopNode({ limit: 2 }), pages)
    expect(limited.map((i) => i.id)).toEqual(['a', 'b'])

    const sorted = selectSitePagesLoopItems(
      makeLoopNode({ orderBy: 'title', direction: 'desc' }),
      pages,
    )
    expect(sorted.map((i) => i.id)).toEqual(['c', 'b', 'a'])
  })

  it('returns the shared empty result for a missing pages list', () => {
    const node = makeLoopNode()
    expect(selectSitePagesLoopItems(node, null)).toBe(selectSitePagesLoopItems(node, null))
    expect(selectSitePagesLoopItems(node, null)).toHaveLength(0)
  })

  it('projects pages through the engine projection (permalink normalization)', () => {
    const node = makeLoopNode()
    const items = selectSitePagesLoopItems(node, [makePage('home', 'Home', 'index')])
    expect(items[0].fields.permalink).toBe('/')
    expect(items[0].fields.slug).toBe('index')
  })
})
