/**
 * Tests for the publisher's `base.loop` interceptor: round-robin children,
 * entry-stack push/pop, multiple loops on a page, nested loop inside a
 * single-entry template (parentEntry binding), and pagination markup.
 */

import { describe, expect, it } from 'bun:test'
import { makeModule, makePage, makeRegistry, makeSite } from './helpers'
import { publishPage, type ResolvedLoopRenderData } from '@core/publisher'
import type { LoopItem } from '@core/loops/types'

function loopData(items: LoopItem[]): ResolvedLoopRenderData {
  return { items, totalItems: items.length, pageNumber: 1, hasMore: false }
}

function loopDataWithMore(items: LoopItem[], pageSize: number): ResolvedLoopRenderData {
  return { items, totalItems: items.length + pageSize, pageNumber: 1, hasMore: true }
}

const textModule = makeModule('base.text', {
  render: (props) => ({
    html: `<p>${String((props as { text: string }).text)}</p>`,
  }),
})

const containerModule = makeModule('base.container', {
  canHaveChildren: true,
  render: (_props, children) => ({ html: `<div>${children.join('')}</div>` }),
})

const rootModule = makeModule('base.body', {
  canHaveChildren: true,
  render: (_props, children) => ({ html: `<main>${children.join('')}</main>` }),
})

const loopModule = makeModule('base.loop', {
  canHaveChildren: true,
  // Defense-in-depth fallback that should never be called — interceptor
  // handles loop rendering. If it IS called, the test will see this.
  render: () => ({ html: '<!-- instatic: loop default render hit -->' }),
})

// Renders BOTH the parentEntry and currentEntry bindings in one element so a
// single output token (`parent/current`) reveals the exact entry-stack frames
// visible during that iteration. Used by the entry-stack isolation tests.
const pairModule = makeModule('test.pair', {
  render: (props) => ({
    html: `<p>${String((props as { parent: string }).parent)}/${String((props as { current: string }).current)}</p>`,
  }),
})

const baseRegistry = makeRegistry({
  'base.body': rootModule,
  'base.text': textModule,
  'base.container': containerModule,
  'base.loop': loopModule,
  'test.pair': pairModule,
})

function makeItem(id: string, title: string): LoopItem {
  return { id, fields: { id, title } }
}

describe('publisher loop renderer', () => {
  it('renders one child per item with binding to currentEntry', () => {
    const items = [makeItem('a', 'Alpha'), makeItem('b', 'Beta'), makeItem('c', 'Gamma')]
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['card'], props: { sourceId: 'test' } },
      card: {
        moduleId: 'base.text',
        props: { text: 'fallback' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopData(items)]]),
    }).html

    expect(html).toContain('<p>Alpha</p>')
    expect(html).toContain('<p>Beta</p>')
    expect(html).toContain('<p>Gamma</p>')
    // currentEntry is restored after the loop — no leakage.
  })

  it('round-robins children across iterations', () => {
    const items = [
      makeItem('1', 'one'),
      makeItem('2', 'two'),
      makeItem('3', 'three'),
      makeItem('4', 'four'),
    ]
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['variantA', 'variantB'] },
      variantA: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
      variantB: {
        moduleId: 'base.container',
        children: ['variantBText'],
      },
      variantBText: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopData(items)]]),
    }).html

    // Iteration order must be A(one), B(two), A(three), B(four).
    const oneIdx = html.indexOf('<p>one</p>')
    const twoIdx = html.indexOf('<div><p>two</p></div>')
    const threeIdx = html.indexOf('<p>three</p>')
    const fourIdx = html.indexOf('<div><p>four</p></div>')
    expect(oneIdx).toBeGreaterThanOrEqual(0)
    expect(twoIdx).toBeGreaterThan(oneIdx)
    expect(threeIdx).toBeGreaterThan(twoIdx)
    expect(fourIdx).toBeGreaterThan(threeIdx)
  })

  it('renders empty when items list is empty', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['card'] },
      card: { moduleId: 'base.text', props: { text: 'fallback' } },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopData([])]]),
    }).html

    expect(html).not.toContain('<p>fallback</p>')
    // Wrapper div from renderLoop should not appear when items is empty.
    expect(html).toContain('<main></main>')
  })

  it('emits a marker comment when loop data is missing', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['card'] },
      card: { moduleId: 'base.text', props: { text: 'fallback' } },
    })
    const html = publishPage(page, makeSite(), baseRegistry).html
    expect(html).toContain('has no resolved data')
  })

  it('supports multiple loops on a page with independent data', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loopA', 'loopB'] },
      loopA: { moduleId: 'base.loop', children: ['cardA'] },
      cardA: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
      loopB: { moduleId: 'base.loop', children: ['cardB'] },
      cardB: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([
        ['loopA', loopData([makeItem('a', 'Apple')])],
        ['loopB', loopData([makeItem('b', 'Banana'), makeItem('c', 'Cherry')])],
      ]),
    }).html

    expect(html).toContain('<p>Apple</p>')
    expect(html).toContain('<p>Banana</p>')
    expect(html).toContain('<p>Cherry</p>')
  })

  it('exposes parentEntry to bindings inside a nested loop', () => {
    const outer = makeItem('outer', 'Outer Post')
    const inner = [makeItem('1', 'Inner 1'), makeItem('2', 'Inner 2')]
    const page = makePage({
      root: { moduleId: 'base.body', children: ['header', 'loop'] },
      header: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
      loop: { moduleId: 'base.loop', children: ['card'] },
      card: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'parentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      // Outer template seeds the entry stack with the post being viewed
      templateContext: { entryStack: [outer] },
      loopData: new Map([['loop', loopData(inner)]]),
    }).html

    // Header (outside loop) → currentEntry = outer
    expect(html).toContain('<p>Outer Post</p>')
    // Cards inside loop → parentEntry = outer (rendered N times)
    const matches = html.match(/<p>Outer Post<\/p>/g)
    expect(matches?.length).toBe(3) // header + 2 iterations
  })

  // ---------------------------------------------------------------------------
  // Entry-stack isolation (audit findings #2 / #10): renderLoop must NOT mutate
  // a shared entryStack in place. Each iteration renders against a fresh
  // per-iteration snapshot, so a nested loop (or VC ref) in the body sees the
  // correct outer frame and no state leaks between iterations.
  // ---------------------------------------------------------------------------
  describe('entry-stack isolation across iterations', () => {
    // Outer loop iterates posts; its body is an INNER loop whose card binds
    // currentEntry (the inner item) AND parentEntry (the outer item). A correct
    // implementation pairs every outer item with every inner item; a shared
    // mutable stack would corrupt the parentEntry frame across iterations.
    function nestedLoopPage() {
      return makePage({
        root: { moduleId: 'base.body', children: ['outer'] },
        outer: { moduleId: 'base.loop', children: ['inner'], props: { sourceId: 'outer' } },
        inner: { moduleId: 'base.loop', children: ['card'], props: { sourceId: 'inner' } },
        card: {
          moduleId: 'test.pair',
          props: { parent: '', current: '' },
          dynamicBindings: {
            parent: { source: 'parentEntry', field: 'title' },
            current: { source: 'currentEntry', field: 'title' },
          },
        },
      })
    }

    it('pairs every outer item with every inner item — no cross-iteration leakage', () => {
      const outerItems = [makeItem('p1', 'P1'), makeItem('p2', 'P2')]
      const innerItems = [makeItem('c1', 'C1'), makeItem('c2', 'C2')]
      const html = publishPage(nestedLoopPage(), makeSite(), baseRegistry, {
        loopData: new Map([
          ['outer', loopData(outerItems)],
          ['inner', loopData(innerItems)],
        ]),
      }).html

      // Every (parent, current) combination renders exactly once, in order.
      expect(html).toContain('<p>P1/C1</p>')
      expect(html).toContain('<p>P1/C2</p>')
      expect(html).toContain('<p>P2/C1</p>')
      expect(html).toContain('<p>P2/C2</p>')
      // The inner loop's frame never bleeds into the parent frame: there is no
      // pairing where parent and current are both inner items (e.g. "C1/C2").
      expect(html).not.toContain('<p>C1/')
      expect(html).not.toContain('<p>C2/')
    })

    it('is order-independent — reversing the outer items reverses only the output order', () => {
      const innerItems = [makeItem('c1', 'C1'), makeItem('c2', 'C2')]
      const forward = publishPage(nestedLoopPage(), makeSite(), baseRegistry, {
        loopData: new Map([
          ['outer', loopData([makeItem('p1', 'P1'), makeItem('p2', 'P2')])],
          ['inner', loopData(innerItems)],
        ]),
      }).html
      const reversed = publishPage(nestedLoopPage(), makeSite(), baseRegistry, {
        loopData: new Map([
          ['outer', loopData([makeItem('p2', 'P2'), makeItem('p1', 'P1')])],
          ['inner', loopData(innerItems)],
        ]),
      }).html

      // Same set of pairings regardless of order — each iteration is independent.
      for (const token of ['<p>P1/C1</p>', '<p>P1/C2</p>', '<p>P2/C1</p>', '<p>P2/C2</p>']) {
        expect(forward).toContain(token)
        expect(reversed).toContain(token)
      }
      // Order actually flipped: P2's block precedes P1's in the reversed render.
      expect(reversed.indexOf('<p>P2/C1</p>')).toBeLessThan(reversed.indexOf('<p>P1/C1</p>'))
      expect(forward.indexOf('<p>P1/C1</p>')).toBeLessThan(forward.indexOf('<p>P2/C1</p>'))
    })

    it('does not leak the loop entry to a sibling rendered after the loop', () => {
      // A header binds currentEntry against the OUTER template frame; the loop
      // that follows must not leave its last item on the stack for the sibling.
      const page = makePage({
        root: { moduleId: 'base.body', children: ['loop', 'footer'] },
        loop: { moduleId: 'base.loop', children: ['card'], props: { sourceId: 'test' } },
        card: {
          moduleId: 'base.text',
          props: { text: '' },
          dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
        },
        footer: {
          moduleId: 'base.text',
          props: { text: '' },
          dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
        },
      })
      const html = publishPage(page, makeSite(), baseRegistry, {
        // Outer template entry the footer should resolve against.
        templateContext: { entryStack: [makeItem('outer', 'OUTER')] },
        loopData: new Map([['loop', loopData([makeItem('a', 'Alpha'), makeItem('b', 'Beta')])]]),
      }).html

      expect(html).toContain('<p>Alpha</p>')
      expect(html).toContain('<p>Beta</p>')
      // Footer renders the OUTER entry, not the loop's last item (Beta).
      const footerIdx = html.lastIndexOf('<p>OUTER</p>')
      expect(footerIdx).toBeGreaterThan(html.indexOf('<p>Beta</p>'))
    })

    it('resolves an entry-field loop separately for every outer item', () => {
      const page = makePage({
        root: { moduleId: 'base.body', children: ['outer'] },
        outer: { moduleId: 'base.loop', children: ['inner'], props: { sourceId: 'outer' } },
        inner: {
          moduleId: 'base.loop',
          children: ['card'],
          props: {
            sourceId: 'entry.field',
            filters: { fieldId: 'gallery' },
            direction: 'asc',
            limit: 10,
          },
        },
        card: {
          moduleId: 'test.pair',
          props: { parent: '', current: '' },
          dynamicBindings: {
            parent: { source: 'parentEntry', field: 'title' },
            current: { source: 'currentEntry', field: 'value' },
          },
        },
      })
      const outerItems: LoopItem[] = [
        { id: 'p1', fields: { title: 'Project 1', gallery: ['p1-a', 'p1-b'] } },
        { id: 'p2', fields: { title: 'Project 2', gallery: ['p2-a'] } },
      ]
      const html = publishPage(page, makeSite(), baseRegistry, {
        loopData: new Map([['outer', loopData(outerItems)]]),
      }).html

      expect(html).toContain('<p>Project 1/p1-a</p>')
      expect(html).toContain('<p>Project 1/p1-b</p>')
      expect(html).toContain('<p>Project 2/p2-a</p>')
      expect(html).not.toContain('Project 1/p2-a')
      expect(html).not.toContain('Project 2/p1-a')
    })
  })

  it('attaches data attrs and registers infinite mode', () => {
    const items = [makeItem('1', 'one'), makeItem('2', 'two')]
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: {
        moduleId: 'base.loop',
        children: ['card'],
        props: { pagination: 'infinite', pageSize: 2 },
      },
      card: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopDataWithMore(items, 2)]]),
    }).html

    expect(html).toContain('data-instatic-loop="loop"')
    expect(html).toContain('data-instatic-loop-mode="infinite"')
    expect(html).toContain('data-instatic-loop-has-more="true"')
    expect(html).toContain('data-instatic-loop-page-size="2"')
    // Loop runtime script injected when at least one infinite loop exists
    expect(html).toContain('/_instatic/assets/loop-runtime.js')
  })

  it('does not inject the loop runtime when no loop is infinite', () => {
    const items = [makeItem('1', 'one')]
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['card'] },
      card: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopData(items)]]),
    }).html

    expect(html).not.toContain('loop-runtime.js')
  })
})

// ---------------------------------------------------------------------------
// Author attributes on the wrapper
// ---------------------------------------------------------------------------

describe('publisher loop renderer — htmlAttributes', () => {
  const items = [makeItem('1', 'one'), makeItem('2', 'two')]

  function publishLoopWith(htmlAttributes: unknown): string {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['card'], props: { htmlAttributes } },
      card: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    return publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopData(items)]]),
    }).html
  }

  it('emits author attributes on the wrapper element', () => {
    // A repeated list is exactly what a carousel / filter script addresses,
    // and what a screen reader needs labelled.
    const html = publishLoopWith({ role: 'list', 'aria-label': 'Members', 'data-marquee': 'slow' })
    expect(html).toContain('role="list"')
    expect(html).toContain('aria-label="Members"')
    expect(html).toContain('data-marquee="slow"')
  })

  it('keeps the loop runtime bookkeeping when an author reuses the name', () => {
    // The shared sanitiser reserves the `data-instatic-*` prefix, so the
    // pagination and hole machinery cannot be redirected from the attributes
    // panel — the author's value never reaches the tag at all.
    const html = publishLoopWith({ 'data-instatic-loop': 'hijacked' })
    expect(html).toContain('data-instatic-loop="loop"')
    expect(html).not.toContain('hijacked')
  })

  it('drops values the attribute sanitiser rejects', () => {
    const html = publishLoopWith({ onclick: 'alert(1)', href: 'javascript:alert(1)' })
    expect(html).not.toContain('alert(1)')
  })

  it('escapes attribute values', () => {
    const html = publishLoopWith({ 'data-label': '"><script>x</script>' })
    expect(html).not.toContain('<script>x</script>')
  })

  it('adds nothing when no attributes are set', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['card'], props: {} },
      card: { moduleId: 'base.text', props: { text: 'x' } },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopData(items)]]),
    }).html
    expect(html).toContain('<div data-instatic-loop="loop" data-instatic-loop-page="1">')
  })
})
