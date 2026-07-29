/**
 * Patch→Y translation — the collaborative write path.
 *
 * The editor keeps producing Mutative patches (same recipes, same mutation
 * API); `applySitePatchesToDocs` translates them into Y operations on the
 * right documents. The invariant under test: after translating a mutation's
 * patches, PROJECTING the docs reproduces the post-mutation site — while
 * inline-text edits go through minimal Y.Text splices (so concurrent remote
 * edits survive) and roster ops land in the site doc.
 *
 * Tests drive REAL patches: `create(site, recipe, { enablePatches })` with
 * actual @core/page-tree mutations, exactly like the store's mutation engine.
 */
import { describe, expect, it } from 'bun:test'
import { create, type Patches } from 'mutative'
import * as Y from 'yjs'
import '@modules/base'
import type { SiteDocument } from '@core/page-tree'
import { addPage, deletePage, moveNode, renamePage, updateNodeProps } from '@core/page-tree'
import {
  applySitePatchesToDocs,
  createCollabDocSet,
  LOCAL_ORIGIN,
  projectPageDoc,
  projectSiteDoc,
  seedPageDoc,
  seedSiteDoc,
  treeMap,
  type CollabDocSet,
} from '@core/collab'
import { makeNode, makePage, makeSite } from '../fixtures'

function fixtureSite(): SiteDocument {
  return makeSite({
    pages: [
      makePage({
        id: 'p1',
        slug: 'index',
        title: 'Home',
        nodes: {
          root: makeNode({ id: 'root', moduleId: 'base.body', children: ['t1', 'c1'] }),
          t1: makeNode({ id: 't1', moduleId: 'base.text', props: { text: 'hello world', tag: 'p' } }),
          c1: makeNode({ id: 'c1', moduleId: 'base.container', children: [] }),
        },
      }),
      makePage({ id: 'p2', slug: 'about', title: 'About' }),
    ],
    styleRules: {
      r1: {
        id: 'r1', name: 'hero', kind: 'class', selector: '.hero', order: 0,
        styles: { color: 'var(--text)' }, contextStyles: {}, createdAt: 1, updatedAt: 1,
      },
    },
  })
}

/** Seed a doc set exactly like the server would, then hand it to the translator. */
function seededDocSet(site: SiteDocument): CollabDocSet {
  const docs = createCollabDocSet()
  seedSiteDoc(docs.ensure('site:default'), site)
  for (const page of site.pages) seedPageDoc(docs.ensure(`page:${page.id}`), page)
  return docs
}

function yTextOf(doc: Y.Doc, nodeId: string): Y.Text {
  const nodes = treeMap(doc).get('nodes') as Y.Map<unknown>
  const node = nodes.get(nodeId) as Y.Map<unknown>
  const props = node.get('props') as Y.Map<unknown>
  return props.get('text') as Y.Text
}

function mutate(
  site: SiteDocument,
  recipe: (draft: SiteDocument) => void,
): { next: SiteDocument; patches: Patches } {
  const [next, patches] = create(site, recipe, { enablePatches: true })
  return { next, patches }
}

function translate(site: SiteDocument, docs: CollabDocSet, recipe: (d: SiteDocument) => void): SiteDocument {
  const { next, patches } = mutate(site, recipe)
  applySitePatchesToDocs(patches, site, next, docs, LOCAL_ORIGIN)
  return next
}

describe('applySitePatchesToDocs — page tree edits', () => {
  it('prop set projects back identical to the post-mutation page', () => {
    const site = fixtureSite()
    const docs = seededDocSet(site)
    const next = translate(site, docs, (d) => {
      updateNodeProps(d.pages[0], 't1', { tag: 'h2' })
    })
    const projected = projectPageDoc(docs.ensure('page:p1'), 'p1')
    expect(projected.nodes.t1.props.tag).toBe('h2')
    expect(projected.nodes.t1.props.text).toBe('hello world')
    expect(projected.nodes.root.children).toEqual(next.pages[0].nodes.root.children)
  })

  it('inline-text edit splices Y.Text so a concurrent remote insertion survives', () => {
    const site = fixtureSite()
    const docs = seededDocSet(site)
    const local = docs.ensure('page:p1')
    // Remote peer shares history and types at the end concurrently.
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local))
    const remoteText = (
      (treeMap(remote).get('nodes') as Y.Map<unknown>).get('t1') as Y.Map<unknown>
    ).get('props') as Y.Map<unknown>
    ;(remoteText.get('text') as Y.Text).insert(11, ' [remote]')

    translate(site, docs, (d) => {
      updateNodeProps(d.pages[0], 't1', { text: 'hello brave world' })
    })

    // Exchange updates both ways.
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local, Y.encodeStateVector(remote)))
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local)))

    const merged = projectPageDoc(local, 'p1').nodes.t1.props.text as string
    expect(merged).toContain('brave')
    expect(merged).toContain('[remote]')
    expect(projectPageDoc(remote, 'p1').nodes.t1.props.text).toBe(merged)
  })

  it('falls back safely when the projected pre-value drifted from the live Y.Text', () => {
    const site = fixtureSite()
    const docs = seededDocSet(site)
    const local = docs.ensure('page:p1')
    // Simulate a caller holding a stale JSON snapshot after a remote update
    // already landed in the authoritative doc. The stale splice indexes used
    // to target the wrong characters or throw when the live text was shorter.
    yTextOf(local, 't1').delete(0, 11)
    yTextOf(local, 't1').insert(0, 'x')

    expect(() => {
      translate(site, docs, (d) => {
        updateNodeProps(d.pages[0], 't1', { text: 'hello brave world' })
      })
    }).not.toThrow()
    expect(projectPageDoc(local, 'p1').nodes.t1.props.text).toBe('hello brave world')
  })

  it('node move and delete project back identical children', () => {
    const site = fixtureSite()
    const docs = seededDocSet(site)
    const next = translate(site, docs, (d) => {
      moveNode(d.pages[0], 'c1', 'root', 0) // move c1 before t1
    })
    expect(projectPageDoc(docs.ensure('page:p1'), 'p1').nodes.root.children)
      .toEqual(next.pages[0].nodes.root.children)

    const next2 = translate(next, docs, (d) => {
      // deleteNode is tree-level; page IS a NodeTree
      d.pages[0].nodes.root.children = d.pages[0].nodes.root.children.filter((c) => c !== 'c1')
      delete d.pages[0].nodes.c1
    })
    const projected = projectPageDoc(docs.ensure('page:p1'), 'p1')
    expect(projected.nodes.c1).toBeUndefined()
    expect(projected.nodes.root.children).toEqual(next2.pages[0].nodes.root.children)
  })

  it('page rename lands in the page meta', () => {
    const site = fixtureSite()
    const docs = seededDocSet(site)
    translate(site, docs, (d) => {
      renamePage(d, 'p1', 'Homepage', 'index')
    })
    expect(projectPageDoc(docs.ensure('page:p1'), 'p1').title).toBe('Homepage')
  })
})

describe('applySitePatchesToDocs — rosters', () => {
  it('addPage creates the roster entry AND populates a fresh page doc', () => {
    const site = fixtureSite()
    const docs = seededDocSet(site)
    let newId = ''
    translate(site, docs, (d) => {
      newId = addPage(d, 'Fresh', 'fresh').id
    })
    const projectedSite = projectSiteDoc(docs.ensure('site:default'))
    expect(projectedSite.rosters.pages).toContain(newId)
    const projectedPage = projectPageDoc(docs.ensure(`page:${newId}`), newId)
    expect(projectedPage.title).toBe('Fresh')
    expect(Object.keys(projectedPage.nodes).length).toBeGreaterThan(0)
  })

  it('deletePage removes the roster entry (the doc is left for relay GC)', () => {
    const site = fixtureSite()
    const docs = seededDocSet(site)
    translate(site, docs, (d) => {
      deletePage(d, 'p2')
    })
    const projected = projectSiteDoc(docs.ensure('site:default'))
    expect(projected.rosters.pages).not.toContain('p2')
    expect(projected.rosters.pages).toContain('p1')
  })

  it('page reorder rewrites pageOrder', () => {
    const site = fixtureSite()
    const docs = seededDocSet(site)
    translate(site, docs, (d) => {
      const [a, b] = d.pages
      d.pages[0] = b
      d.pages[1] = a
    })
    expect(projectSiteDoc(docs.ensure('site:default')).rosters.pages).toEqual(['p2', 'p1'])
  })
})

describe('applySitePatchesToDocs — shell', () => {
  it('style rule edits land per-rule; settings edits per top-level key', () => {
    const site = fixtureSite()
    const docs = seededDocSet(site)
    translate(site, docs, (d) => {
      d.styleRules.r1.styles.color = 'var(--text-muted)'
      d.settings.metaTitle = 'Acme rules'
    })
    const projected = projectSiteDoc(docs.ensure('site:default'))
    const rule = projected.shell.styleRules as Record<string, { styles: Record<string, unknown> }>
    expect(rule.r1.styles.color).toBe('var(--text-muted)')
    expect((projected.shell.settings as Record<string, unknown>).metaTitle).toBe('Acme rules')
  })

  it('site rename is a plain shell field write', () => {
    const site = fixtureSite()
    const docs = seededDocSet(site)
    translate(site, docs, (d) => {
      d.name = 'Renamed'
    })
    expect(projectSiteDoc(docs.ensure('site:default')).shell.name).toBe('Renamed')
  })
})
