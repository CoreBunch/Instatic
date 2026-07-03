/**
 * Collab core — seed → project round-trips (Yjs docs ⇄ domain JSON).
 *
 * The projection is the ONLY reader of Y state and must reproduce the domain
 * shape exactly (minus `parentId`, which is derived and re-indexed), heal
 * tree-integrity damage deterministically (duplicate child ids, orphan
 * nodes — possible under rare concurrent-merge interleavings), and reconcile
 * the shell's roster order against roster membership.
 *
 * `import '@modules/base'` populates the module registry so `base.text`'s
 * inline-text prop (`text`) seeds as Y.Text — the character-merge substrate.
 */
import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import '@modules/base'
import {
  projectComponentDoc,
  projectLayoutDoc,
  projectPageDoc,
  projectSiteDoc,
  seedComponentDoc,
  seedLayoutDoc,
  seedPageDoc,
  seedSiteDoc,
  treeMap,
} from '@core/collab'
import { makeNode, makePage, makeSite, makeVC } from '../fixtures'

function fixturePage() {
  return makePage({
    id: 'p1',
    slug: 'index',
    title: 'Home',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['t1', 'c1'] }),
      t1: makeNode({ id: 't1', moduleId: 'base.text', props: { text: 'Hello', tag: 'p' } }),
      c1: makeNode({ id: 'c1', moduleId: 'base.container', children: [] }),
    },
  })
}

describe('page doc seed → project round-trip', () => {
  it('projects back exactly the seeded page (parentId re-derived)', () => {
    const page = fixturePage()
    const doc = new Y.Doc()
    seedPageDoc(doc, page)
    const projected = projectPageDoc(doc, 'p1')

    expect(projected.id).toBe('p1')
    expect(projected.title).toBe('Home')
    expect(projected.slug).toBe('index')
    expect(projected.rootNodeId).toBe(page.rootNodeId)
    expect(projected.nodes.t1.props.text).toBe('Hello')
    expect(projected.nodes.t1.props.tag).toBe('p')
    expect(projected.nodes.root.children).toEqual(['t1', 'c1'])
    expect(projected.nodes.t1.parentId).toBe('root') // reindexed, not stored
  })

  it('stores the inline-text prop as Y.Text (character-merge substrate)', () => {
    const doc = new Y.Doc()
    seedPageDoc(doc, fixturePage())
    const nodes = treeMap(doc).get('nodes') as Y.Map<unknown>
    const t1 = nodes.get('t1') as Y.Map<unknown>
    const props = t1.get('props') as Y.Map<unknown>
    expect(props.get('text')).toBeInstanceOf(Y.Text)
    expect((props.get('text') as Y.Text).toString()).toBe('Hello')
    expect(props.get('tag')).toBe('p') // non-inline props stay plain
  })

  it('round-trips breakpoint overrides and scalar node fields', () => {
    const page = makePage({
      id: 'p2',
      slug: 'about',
      title: 'About',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['b1'] }),
        b1: makeNode({
          id: 'b1',
          moduleId: 'base.container',
          label: 'Hero',
          locked: true,
          classIds: ['cls-1'],
          breakpointOverrides: { mobile: { gap: '8px' } },
        }),
      },
    })
    const doc = new Y.Doc()
    seedPageDoc(doc, page)
    const projected = projectPageDoc(doc, 'p2')
    expect(projected.nodes.b1.label).toBe('Hero')
    expect(projected.nodes.b1.locked).toBe(true)
    expect(projected.nodes.b1.classIds).toEqual(['cls-1'])
    expect(projected.nodes.b1.breakpointOverrides).toEqual({ mobile: { gap: '8px' } })
  })
})

describe('component + layout doc round-trips', () => {
  it('projects a VC back with tree, params and meta intact', () => {
    const vc = makeVC({ id: 'vc1', name: 'Card' })
    const doc = new Y.Doc()
    seedComponentDoc(doc, vc)
    const projected = projectComponentDoc(doc, 'vc1')
    expect(projected.id).toBe('vc1')
    expect(projected.name).toBe('Card')
    expect(projected.tree.rootNodeId).toBe(vc.tree.rootNodeId)
    expect(Object.keys(projected.tree.nodes)).toEqual(Object.keys(vc.tree.nodes))
    expect(projected.params).toEqual(vc.params)
  })

  it('projects a layout back from its whole-snapshot storage', () => {
    const layout = {
      id: 'l1',
      name: 'Hero section',
      rootNodeId: 'root',
      nodes: { root: makeNode({ id: 'root', moduleId: 'base.container' }) },
      classes: {},
      createdAt: 1_700_000_000_000,
    }
    const doc = new Y.Doc()
    seedLayoutDoc(doc, layout)
    const projected = projectLayoutDoc(doc, 'l1')
    expect(projected.name).toBe('Hero section')
    expect(projected.rootNodeId).toBe('root')
    expect(Object.keys(projected.nodes)).toEqual(['root'])
  })
})

describe('site doc (shell + rosters)', () => {
  it('projects shell fields, per-entry maps, and rosters back', () => {
    const site = makeSite({
      name: 'Acme',
      pages: [makePage({ id: 'a', slug: 'index' }), makePage({ id: 'b', slug: 'b' })],
      visualComponents: [makeVC({ id: 'vc1', name: 'Card' })],
      styleRules: {
        r1: {
          id: 'r1', name: 'hero', kind: 'class', selector: '.hero', order: 0,
          styles: { color: 'var(--text)' }, contextStyles: {}, createdAt: 1, updatedAt: 1,
        },
      },
    })
    const doc = new Y.Doc()
    seedSiteDoc(doc, site)
    const projected = projectSiteDoc(doc)
    expect(projected.shell.name).toBe('Acme')
    expect(projected.shell.styleRules.r1.selector).toBe('.hero')
    expect(projected.shell.settings).toEqual(site.settings)
    expect(projected.rosters.pages).toEqual(['a', 'b'])
    expect(projected.rosters.components).toEqual(['vc1'])
  })

  it('reconciles roster order against membership (dedupe, append missing, drop deleted)', () => {
    const site = makeSite({
      pages: [makePage({ id: 'a', slug: 'index' }), makePage({ id: 'b', slug: 'b' })],
    })
    const doc = new Y.Doc()
    seedSiteDoc(doc, site)
    doc.transact(() => {
      const rosters = doc.getMap<unknown>('rosters')
      const order = rosters.get('pageOrder') as Y.Array<string>
      order.push(['a']) // duplicate
      order.push(['ghost']) // not a member
      const pages = rosters.get('pages') as Y.Map<unknown>
      pages.set('c', true) // member missing from order
    })
    const projected = projectSiteDoc(doc)
    expect(projected.rosters.pages).toEqual(['a', 'b', 'c'])
  })
})

describe('tree-integrity reconcile', () => {
  it('heals duplicate child ids and re-attaches orphan nodes deterministically', () => {
    const doc = new Y.Doc()
    seedPageDoc(doc, fixturePage())
    doc.transact(() => {
      const nodes = treeMap(doc).get('nodes') as Y.Map<unknown>
      const root = nodes.get('root') as Y.Map<unknown>
      ;(root.get('children') as Y.Array<string>).push(['t1']) // duplicate child
      // Orphan node referenced by nothing:
      const ghost = new Y.Map<unknown>()
      ghost.set('id', 'ghost')
      ghost.set('moduleId', 'base.text')
      ghost.set('props', new Y.Map())
      ghost.set('breakpointOverrides', new Y.Map())
      ghost.set('children', new Y.Array())
      nodes.set('ghost', ghost)
      // Dangling child id with no node entry:
      ;(root.get('children') as Y.Array<string>).push(['missing-node'])
    })
    const projected = projectPageDoc(doc, 'p1')
    expect(projected.nodes.root.children.filter((c) => c === 't1')).toHaveLength(1)
    expect(projected.nodes.root.children).not.toContain('missing-node')
    expect(projected.nodes.root.children).toContain('ghost')
    expect(projected.nodes.ghost.parentId).toBe('root')
  })
})
