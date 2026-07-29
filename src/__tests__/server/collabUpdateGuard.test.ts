import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import {
  dataMap,
  metaMap,
  rostersMap,
  seedComponentDoc,
  seedLayoutDoc,
  seedPageDoc,
  seedSiteDoc,
  shellMap,
  SITE_DOC_ID,
  treeMap,
} from '@core/collab'
import type { CoreCapability } from '@core/capabilities'
import type { SavedLayout } from '@core/layouts'
import { validateGuardedUpdate } from '../../../server/collab/updateGuard'
import { makeNode, makePage, makeSite, makeVC } from '../fixtures'

const CONTENT: CoreCapability[] = ['site.content.edit']
const STYLE: CoreCapability[] = ['site.style.edit']
const STRUCTURE: CoreCapability[] = ['site.structure.edit']

function updateFrom(doc: Y.Doc, mutate: (fork: Y.Doc) => void): Uint8Array {
  const fork = new Y.Doc()
  Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc))
  const stateVector = Y.encodeStateVector(doc)
  fork.transact(() => mutate(fork))
  return Y.encodeStateAsUpdate(fork, stateVector)
}

function nodeMap(doc: Y.Doc, nodeId: string): Y.Map<unknown> {
  const nodes = treeMap(doc).get('nodes') as Y.Map<unknown>
  return nodes.get(nodeId) as Y.Map<unknown>
}

function expectAllowed(
  docId: string,
  doc: Y.Doc,
  update: Uint8Array,
  capabilities: CoreCapability[],
): void {
  expect(validateGuardedUpdate(docId, doc, update, capabilities)).toEqual({ ok: true })
}

function expectForbidden(
  docId: string,
  doc: Y.Doc,
  update: Uint8Array,
  capabilities: CoreCapability[],
  reason: string,
): void {
  expect(validateGuardedUpdate(docId, doc, update, capabilities)).toMatchObject({
    ok: false,
    reason: expect.stringContaining(reason),
  })
}

describe('collab update capability guard', () => {
  it('separates page content, style, and structure updates', () => {
    const page = makePage({
      id: 'page-1',
      nodes: {
        root: makeNode({
          id: 'root',
          moduleId: 'base.body',
          children: ['copy'],
        }),
        copy: makeNode({
          id: 'copy',
          moduleId: 'base.text',
          props: { text: 'Original' },
        }),
      },
    })
    const doc = new Y.Doc()
    seedPageDoc(doc, page)
    const docId = 'page:page-1'

    const contentUpdate = updateFrom(doc, (fork) => {
      const props = nodeMap(fork, 'copy').get('props') as Y.Map<unknown>
      const text = props.get('text') as Y.Text
      text.insert(text.length, ' copy')
    })
    expectAllowed(docId, doc, contentUpdate, CONTENT)
    expectForbidden(docId, doc, contentUpdate, STYLE, 'forbidden content change')

    const styleUpdate = updateFrom(doc, (fork) => {
      nodeMap(fork, 'copy').set('classIds', ['hero-copy'])
    })
    expectAllowed(docId, doc, styleUpdate, STYLE)
    expectForbidden(docId, doc, styleUpdate, CONTENT, 'forbidden style change')

    const structureUpdate = updateFrom(doc, (fork) => {
      nodeMap(fork, 'copy').set('label', 'Hero copy')
    })
    expectAllowed(docId, doc, structureUpdate, STRUCTURE)
    expectForbidden(docId, doc, structureUpdate, CONTENT, 'forbidden structure change')
  })

  it('separates site-shell content, style, structure, and roster updates', () => {
    const site = makeSite()
    const doc = new Y.Doc()
    seedSiteDoc(doc, site)

    const contentUpdate = updateFrom(doc, (fork) => {
      const settings = shellMap(fork).get('settings') as Y.Map<unknown>
      settings.set('metaTitle', 'Collaborative title')
    })
    expectAllowed(SITE_DOC_ID, doc, contentUpdate, CONTENT)
    expectForbidden(SITE_DOC_ID, doc, contentUpdate, STYLE, 'forbidden content change')

    const styleUpdate = updateFrom(doc, (fork) => {
      const styleRules = shellMap(fork).get('styleRules') as Y.Map<unknown>
      styleRules.set('hero-copy', {
        id: 'hero-copy',
        name: 'Hero copy',
        styles: { color: 'var(--foreground)' },
      })
    })
    expectAllowed(SITE_DOC_ID, doc, styleUpdate, STYLE)
    expectForbidden(SITE_DOC_ID, doc, styleUpdate, CONTENT, 'forbidden style change')

    const structureUpdate = updateFrom(doc, (fork) => {
      shellMap(fork).set('name', 'Renamed site')
    })
    expectAllowed(SITE_DOC_ID, doc, structureUpdate, STRUCTURE)
    expectForbidden(SITE_DOC_ID, doc, structureUpdate, CONTENT, 'forbidden structure change')

    const rosterUpdate = updateFrom(doc, (fork) => {
      const pages = rostersMap(fork).get('pages') as Y.Map<unknown>
      pages.set('page-2', true)
    })
    expectAllowed(SITE_DOC_ID, doc, rosterUpdate, STRUCTURE)
    expectForbidden(SITE_DOC_ID, doc, rosterUpdate, CONTENT, 'roster changes')
  })

  it('requires structure capability for component and layout documents', () => {
    const componentDoc = new Y.Doc()
    seedComponentDoc(componentDoc, makeVC({ id: 'component-1', name: 'Hero' }))
    const componentUpdate = updateFrom(componentDoc, (fork) => {
      metaMap(fork).set('name', 'Renamed hero')
    })
    expectAllowed('component:component-1', componentDoc, componentUpdate, STRUCTURE)
    expectForbidden(
      'component:component-1',
      componentDoc,
      componentUpdate,
      CONTENT,
      'component changes require',
    )

    const layout: SavedLayout = {
      id: 'layout-1',
      name: 'Hero layout',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body' }),
      },
      classes: {},
      createdAt: 1_700_000_000_000,
    }
    const layoutDoc = new Y.Doc()
    seedLayoutDoc(layoutDoc, layout)
    const layoutUpdate = updateFrom(layoutDoc, (fork) => {
      dataMap(fork).set('snapshot', {
        ...dataMap(fork).get('snapshot') as Record<string, unknown>,
        classes: { 'hero-layout': { id: 'hero-layout', name: 'Hero layout', styles: {} } },
      })
    })
    expectAllowed('layout:layout-1', layoutDoc, layoutUpdate, STRUCTURE)
    expectForbidden(
      'layout:layout-1',
      layoutDoc,
      layoutUpdate,
      STYLE,
      'layout changes require',
    )
  })

  it('rejects updates for unknown document ids', () => {
    const doc = new Y.Doc()
    const update = updateFrom(doc, (fork) => {
      fork.getMap('unknown').set('value', true)
    })
    expect(validateGuardedUpdate('unknown:doc', doc, update, STRUCTURE)).toEqual({
      ok: false,
      reason: 'unknown doc id unknown:doc',
    })
  })
})
