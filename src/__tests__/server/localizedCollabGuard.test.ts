import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import '@modules/base'
import { applyLocalizationDraftToDoc, dataMap, encodeCollabDocId, metaMap, projectLocalizationDoc, seedLocalizationDoc } from '@core/collab'
import type { DataField } from '@core/data/schemas'
import type { CoreCapability } from '@core/capabilities'
import { validateGuardedUpdate } from '../../../server/collab/updateGuard'
import { makeNode, makeVC } from '../fixtures'

const docId = encodeCollabDocId({ kind: 'page', rowId: 'p1', localeId: 'de' })
const fields: DataField[] = [
  { id: 'title', label: 'Title', type: 'text', localization: 'localized' },
  { id: 'body', label: 'Body', type: 'pageTree', localization: 'localized' },
  { id: 'templateEnabled', label: 'Template', type: 'boolean', localization: 'shared' },
]
const context = { fields, sharedCells: { body: { rootNodeId: 'root', nodes: {
  root: makeNode({ id: 'root', moduleId: 'base.body', children: ['text'] }),
  text: makeNode({ id: 'text', moduleId: 'base.text', props: { text: 'Source' } }),
} } } }
const full: CoreCapability[] = ['site.content.edit', 'site.structure.edit', 'site.style.edit']

function verdict(mutate: (fork: Y.Doc) => void, capabilities: CoreCapability[] = full) {
  const doc = new Y.Doc(); seedLocalizationDoc(doc, { cells: {}, slug: 'index' })
  const fork = new Y.Doc(); Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc))
  const vector = Y.encodeStateVector(fork)
  mutate(fork)
  const result = validateGuardedUpdate(docId, doc, Y.encodeStateAsUpdate(fork, vector), capabilities, context)
  expect(projectLocalizationDoc(doc)).toEqual({ cells: {}, slug: 'index', translationMeta: {} })
  fork.destroy(); doc.destroy()
  return result
}

describe('localized collab update guard', () => {
  it('allows copy editors to translate metadata and node content without shared structural permission', () => {
    expect(verdict((doc) => applyLocalizationDraftToDoc(doc, projectLocalizationDoc(doc), {
      slug: 'start', cells: { title: 'Startseite', body: { nodes: { text: { props: { text: 'Hallo' }, hidden: false } } } },
    }, 'peer'), ['site.content.edit'])).toEqual({ ok: true })
  })

  it('rejects writes from a viewer while allowing its empty handshake', () => {
    expect(verdict(() => {}, []).ok).toBe(true)
    expect(verdict((doc) => metaMap(doc).set('slug', 'new'), []).ok).toBe(false)
  })

  it('rejects shared field overrides even from a full site writer', () => {
    expect(verdict((doc) => applyLocalizationDraftToDoc(doc, projectLocalizationDoc(doc), { slug: 'index', cells: { templateEnabled: true } }, 'peer')).ok).toBe(false)
  })

  it('rejects non-content props and fabricated nodes before the authoritative doc changes', () => {
    expect(verdict((doc) => applyLocalizationDraftToDoc(doc, projectLocalizationDoc(doc), {
      slug: 'index', cells: { body: { nodes: { text: { props: { componentId: 'other' } } } } },
    }, 'peer')).ok).toBe(false)
    expect(verdict((doc) => applyLocalizationDraftToDoc(doc, projectLocalizationDoc(doc), {
      slug: 'index', cells: { body: { nodes: { fabricated: { props: { text: 'Oops' } } } } },
    }, 'peer')).ok).toBe(false)
  })

  it('enforces component parameter type and binding policy for defaults and instance overrides', () => {
    const component = makeVC({ id: 'card', name: 'Card', params: [
      { id: 'copy', name: 'Copy', type: 'string', defaultValue: 'Hi', required: false },
      { id: 'paint', name: 'Paint', type: 'color', defaultValue: 'red', required: false },
    ] })
    const shared = { fields: [...fields, { id: 'parameterDefaults', label: 'Defaults', type: 'parameterValues' as const, localization: 'localized' as const }],
      sharedCells: { body: component.tree, params: component.params }, components: [component] }
    const doc = new Y.Doc(); seedLocalizationDoc(doc, { cells: {}, slug: 'index' })
    const incoming = (values: Record<string, unknown>) => {
      const fork = new Y.Doc(); Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc))
      applyLocalizationDraftToDoc(fork, projectLocalizationDoc(fork), { cells: { parameterDefaults: values }, slug: 'index' }, 'peer')
      const result = validateGuardedUpdate(docId, doc, Y.encodeStateAsUpdate(fork), full, shared)
      fork.destroy()
      return result.ok
    }
    expect(incoming({ copy: 'Hallo' })).toBe(true)
    expect(incoming({ paint: 'blue' })).toBe(false)
    expect(incoming({ copy: { injected: true } })).toBe(false)
    expect(incoming({ invented: 'Hi' })).toBe(false)
    doc.destroy()
  })

  it('rejects injecting a full body tree through generic cells', () => {
    expect(verdict((doc) => {
      const cells = dataMap(doc).get('cells') as Y.Map<unknown>
      cells.set('body', context.sharedCells.body)
    }).ok).toBe(false)
  })
})
