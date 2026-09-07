import { afterEach, describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import '@modules/base'
import { captureSiteLocalization, projectSiteLocale } from '@core/localization'
import { applyLocalizationDraftToDoc, encodeCollabDocId, metaMap, parseCollabDocId, projectLocalizationDoc, projectPageDoc, seedLocalizationDoc, treeMap, LOCAL_ORIGIN } from '@core/collab'
import type { SiteDocument } from '@core/page-tree'
import type { ContentLocalizationDraftInput } from '@core/localization-schema'
import { useEditorStore } from '@site/store/store'
import { collabDocFor } from '@site/store/slices/site/collabBinding'
import { executeAgentTool } from '@site/agent'
import { toolLocaleId } from '@core/ai'
import { makeNode, makePage, makeSite, makeVC } from '../fixtures'

function localizedSite(): SiteDocument {
  const page = makePage({ id: 'p1', title: 'Hello', slug: 'index', nodes: {
    root: makeNode({ id: 'root', moduleId: 'base.body', children: ['text'] }),
    text: makeNode({ id: 'text', moduleId: 'base.text', props: { text: 'Hello', tag: 'p' } }),
  } })
  const site = makeSite({ pages: [page] })
  site.localeId = 'en'
  site.locales = [
    { id: 'en', code: 'en', name: 'English', isDefault: true, pathPrefix: '', enabled: true, direction: 'ltr' },
    { id: 'de', code: 'de', name: 'Deutsch', isDefault: false, pathPrefix: 'de', enabled: true, direction: 'ltr' },
  ]
  site.localization = {
    fieldLocalizations: { pages: { title: 'localized', slug: 'localized', body: 'localized', templateEnabled: 'shared', templateTarget: 'shared', templatePriority: 'shared' }, components: { name: 'shared', slug: 'shared', body: 'localized', params: 'shared', classIds: 'shared', parameterDefaults: 'localized' }, layouts: { name: 'localized', slug: 'localized', body: 'localized', classes: 'shared' } },
    rows: { p1: { tableId: 'pages', sharedCells: { body: { rootNodeId: 'root', nodes: page.nodes }, templateEnabled: false }, localizations: { en: { cells: { title: 'Hello', slug: 'index' }, slug: 'index' } } } },
  }
  return projectSiteLocale(site, 'en')
}

afterEach(() => useEditorStore.getState().clearSite())

describe('localized collaboration', () => {
  it('pins AI commands to a language and reports rejected structural changes', async () => {
    useEditorStore.getState().loadSite(localizedSite())
    expect(toolLocaleId({}, { site: { localeId: 'en' } })).toBe('en')
    expect(toolLocaleId({ localeId: 'de' }, { localeId: 'en' })).toBe('de')
    const mismatch = await executeAgentTool('site_update_node_props', { localeId: 'de', nodeId: 'text', patch: { text: 'Falsch' } })
    expect(mismatch.ok).toBe(false)
    expect(useEditorStore.getState().site!.pages[0].nodes.text.props.text).toBe('Hello')
    expect((await executeAgentTool('site_select_locale', { localeId: 'de' })).ok).toBe(true)
    expect((await executeAgentTool('site_update_node_props', { localeId: 'de', nodeId: 'text', patch: { text: 'Hallo' } })).ok).toBe(true)
    expect((await executeAgentTool('site_delete_node', { localeId: 'de', nodeId: 'text' })).ok).toBe(false)
    expect((await executeAgentTool('site_update_node_props', { localeId: 'de', nodeId: 'text', patch: { unknownDesignProperty: 'large' } })).ok).toBe(false)
    expect(useEditorStore.getState().site!.pages[0].nodes.text.props).toMatchObject({ text: 'Hallo', tag: 'p' })
  })
  it('keeps source template conversion visible after shared and locale projections', async () => {
    useEditorStore.getState().loadSite(localizedSite())
    const template = { enabled: true, target: { kind: 'postTypes' as const, tableSlugs: ['posts'] }, priority: 100 }
    useEditorStore.getState().convertPageToTemplate('p1', template)
    expect(useEditorStore.getState().site!.pages[0].template).toEqual(template)
    const shared = collabDocFor('page:p1')!
    expect(projectPageDoc(shared, 'p1').template).toEqual(template)
    // A peer's unrelated shared update re-projects the canonical row.
    shared.transact(() => metaMap(shared).set('ownerUserId', 'peer'), 'remote')
    await Promise.resolve()
    expect(useEditorStore.getState().site!.pages[0].template).toEqual(template)
    const source = collabDocFor(encodeCollabDocId({ kind: 'page', rowId: 'p1', localeId: 'en' }))!
    const before = projectLocalizationDoc(source)
    applyLocalizationDraftToDoc(source, before, { ...before, cells: { ...before.cells, title: 'Localized template' } }, 'remote')
    await Promise.resolve()
    expect(useEditorStore.getState().site!.pages[0].template).toEqual(template)
    useEditorStore.getState().convertTemplateToPage('p1')
    expect(useEditorStore.getState().site!.pages[0].template).toBeUndefined()
    shared.transact(() => metaMap(shared).set('ownerUserId', 'another-peer'), 'remote')
    await Promise.resolve()
    expect(useEditorStore.getState().site!.pages[0].template).toBeUndefined()
  })

  it('encodes locale identity without ambiguous row ids', () => {
    const id = encodeCollabDocId({ kind: 'page', rowId: 'page:a', localeId: 'de:at' })
    expect(parseCollabDocId(id)).toEqual({ kind: 'page', rowId: 'page:a', localeId: 'de:at' })
    expect(parseCollabDocId('localization:page:p:de:extra')).toBeNull()
  })

  it('keeps locale text and undo separate while retaining shared layout', () => {
    const store = useEditorStore
    store.getState().loadSite(localizedSite())
    store.getState().updateNodeProps('text', { text: 'Hello source' })
    expect(projectPageDoc(collabDocFor('page:p1')!, 'p1').nodes.text.props.text).toBe('Hello')
    store.getState().setActiveLocaleId('de')
    expect(store.getState().site!.pages[0].nodes.text.props.text).toBe('Hello source')
    expect(store.getState().canUndo).toBe(false)
    store.getState().updateNodeProps('text', { text: 'Hallo' })
    const deDoc = collabDocFor(encodeCollabDocId({ kind: 'page', rowId: 'p1', localeId: 'de' }))!
    expect(projectLocalizationDoc(deDoc).cells.body).toEqual({ nodes: { text: { props: { text: 'Hallo' } } } })
    store.getState().setActiveLocaleId('en')
    expect(store.getState().site!.pages[0].nodes.text.props.text).toBe('Hello source')
    store.getState().undo()
    expect(store.getState().site!.pages[0].nodes.text.props.text).toBe('Hello')
    store.getState().setActiveLocaleId('de')
    expect(store.getState().site!.pages[0].nodes.text.props.text).toBe('Hallo')
    store.getState().undo()
    expect(store.getState().site!.pages[0].nodes.text.props.text).toBe('Hello')
    store.getState().redo()
    expect(store.getState().site!.pages[0].nodes.text.props.text).toBe('Hallo')
  })

  it('applies remote source edits through inheritance without freezing target cells', async () => {
    useEditorStore.getState().loadSite(localizedSite())
    useEditorStore.getState().setActiveLocaleId('de')
    const enDoc = collabDocFor(encodeCollabDocId({ kind: 'page', rowId: 'p1', localeId: 'en' }))!
    const before = projectLocalizationDoc(enDoc)
    applyLocalizationDraftToDoc(enDoc, before, { ...before, cells: { ...before.cells, body: { nodes: { text: { props: { text: 'Changed remotely' } } } } } }, 'remote')
    await Promise.resolve()
    expect(useEditorStore.getState().site!.pages[0].nodes.text.props.text).toBe('Changed remotely')
    expect(useEditorStore.getState().site!.localization!.rows.p1.localizations.de?.cells.body).toBeUndefined()
  })

  it('rejects shared structural changes in target projections and accepts new source nodes', () => {
    const source = localizedSite()
    const target = projectSiteLocale(source, 'de')
    const invalid = structuredClone(target)
    invalid.pages[0].nodes.text.classIds = ['other-class']
    expect(() => captureSiteLocalization(target, invalid)).toThrow()
    const globalDesign = structuredClone(target)
    globalDesign.name = 'Shared rename'
    expect(() => captureSiteLocalization(target, globalDesign)).toThrow('source language')
    useEditorStore.getState().loadSite(source)
    const id = useEditorStore.getState().insertNode('base.text', { text: 'New source', tag: 'p' }, 'root')
    useEditorStore.getState().setActiveLocaleId('de')
    const tree = useEditorStore.getState().site!.pages[0]
    expect(tree.nodes[id].props.text).toBe('New source')
    expect(tree.nodes.root.children).toContain(id)
    expect(projectPageDoc(collabDocFor('page:p1')!, 'p1').nodes[id].props.text).toBeUndefined()
  })

  it('translates component defaults and instance parameters individually while preserving shared design', () => {
    const site = localizedSite()
    const vc = makeVC({ id: 'card', name: 'Card', params: [
      { id: 'heading', name: 'Heading', type: 'string', defaultValue: 'Default heading', required: false },
      { id: 'summary', name: 'Summary', type: 'richText', defaultValue: 'Default summary', required: false },
      { id: 'color', name: 'Color', type: 'color', defaultValue: 'red', required: false },
    ] })
    site.visualComponents = [vc]
    site.localization!.rows.card = { tableId: 'components', sharedCells: {
      name: vc.name, slug: 'card', body: vc.tree, params: vc.params, classIds: [],
    }, localizations: {} }
    site.pages[0].nodes.ref = makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: {
      componentId: 'card', propOverrides: { heading: 'Source heading', summary: 'Source summary', color: 'blue' },
    } })
    site.pages[0].nodes.root.children.push('ref')
    site.localization!.rows.p1.sharedCells.body = { rootNodeId: 'root', nodes: site.pages[0].nodes }
    useEditorStore.getState().loadSite(site)
    useEditorStore.getState().setActiveLocaleId('de')
    useEditorStore.getState().updateParamDefaultValue('card', 'heading', 'Standardüberschrift')
    expect(useEditorStore.getState().site!.visualComponents[0].params[0].defaultValue).toBe('Standardüberschrift')
    expect(useEditorStore.getState().site!.localization!.rows.card.localizations.de.cells.parameterDefaults).toEqual({ heading: 'Standardüberschrift' })
    useEditorStore.getState().updateNodeProps('ref', { propOverrides: { heading: 'Überschrift', summary: 'Source summary', color: 'blue' } })
    expect(projectLocalizationDoc(collabDocFor(encodeCollabDocId({ kind: 'page', rowId: 'p1', localeId: 'de' }))!).cells.body)
      .toEqual({ nodes: { ref: { props: { propOverrides: { heading: 'Überschrift' } } } } })
    useEditorStore.getState().setActiveLocaleId('en')
    useEditorStore.getState().updateParamDefaultValue('card', 'summary', 'New default summary')
    useEditorStore.getState().updateNodeProps('ref', { propOverrides: { heading: 'Source heading', summary: 'New source summary', color: 'green' } })
    useEditorStore.getState().setActiveLocaleId('de')
    expect(useEditorStore.getState().site!.visualComponents[0].params.map((parameter) => parameter.defaultValue))
      .toEqual(['Standardüberschrift', 'New default summary', 'red'])
    expect(useEditorStore.getState().site!.pages[0].nodes.ref.props.propOverrides)
      .toEqual({ heading: 'Überschrift', summary: 'New source summary', color: 'green' })
    const before = useEditorStore.getState().site!
    const invalid = structuredClone(before)
    invalid.pages[0].nodes.ref.props.propOverrides = { color: 'black' }
    expect(() => captureSiteLocalization(before, invalid)).toThrow()
    invalid.visualComponents[0].params[2].defaultValue = 'black'
    expect(() => captureSiteLocalization(before, invalid)).toThrow()
  })

  it('merges concurrent text changes inside the same locale and isolates another locale', () => {
    const seed: ContentLocalizationDraftInput = { cells: { body: { nodes: { text: { props: { text: 'hello' } } } } }, slug: 'index' }
    const first = new Y.Doc(); seedLocalizationDoc(first, seed)
    const second = new Y.Doc(); Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    const other = new Y.Doc(); seedLocalizationDoc(other, { cells: {}, slug: 'index' })
    applyLocalizationDraftToDoc(first, seed, { ...seed, cells: { body: { nodes: { text: { props: { text: 'hello A' } } } } } }, LOCAL_ORIGIN)
    applyLocalizationDraftToDoc(second, seed, { ...seed, cells: { body: { nodes: { text: { props: { text: 'B hello' } } } } } }, LOCAL_ORIGIN)
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second)); Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    expect(projectLocalizationDoc(first)).toEqual(projectLocalizationDoc(second))
    expect(projectLocalizationDoc(first).cells.body).toEqual({ nodes: { text: { props: { text: 'B hello A' } } } })
    expect(projectLocalizationDoc(other).cells).toEqual({})
    first.destroy(); second.destroy(); other.destroy()
  })

  it('preserves concurrent first translations of different nodes in an inherited locale', () => {
    const seed: ContentLocalizationDraftInput = { cells: {}, slug: 'index' }
    const first = new Y.Doc(); seedLocalizationDoc(first, seed)
    const second = new Y.Doc(); Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    applyLocalizationDraftToDoc(first, seed, { ...seed, cells: { body: { nodes: { heading: { props: { text: 'Überschrift' } } } } } }, LOCAL_ORIGIN)
    applyLocalizationDraftToDoc(second, seed, { ...seed, cells: { body: { nodes: { summary: { props: { text: 'Zusammenfassung' } } } } } }, LOCAL_ORIGIN)
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second)); Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    expect(projectLocalizationDoc(first)).toEqual(projectLocalizationDoc(second))
    expect(projectLocalizationDoc(first).cells.body).toEqual({ nodes: {
      heading: { props: { text: 'Überschrift' } }, summary: { props: { text: 'Zusammenfassung' } },
    } })
    applyLocalizationDraftToDoc(first, projectLocalizationDoc(first), seed, LOCAL_ORIGIN)
    expect(projectLocalizationDoc(first).cells.body).toBeUndefined()
    expect(treeMap(first).get('nodes')).toBeInstanceOf(Y.Map)
    first.destroy(); second.destroy()
  })
  it('merges first translations of separate properties and visibility on one inherited node', () => {
    const seed: ContentLocalizationDraftInput = { cells: {}, slug: 'index' }
    const first = new Y.Doc(); seedLocalizationDoc(first, seed)
    const second = new Y.Doc(); Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    applyLocalizationDraftToDoc(first, seed, { ...seed, cells: { body: { nodes: { link: { props: { text: 'Lesen' } } } } } }, LOCAL_ORIGIN)
    applyLocalizationDraftToDoc(second, seed, { ...seed, cells: { body: { nodes: { link: { props: { href: '/de/article' }, hidden: true } } } } }, LOCAL_ORIGIN)
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second)); Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    expect(projectLocalizationDoc(first)).toEqual(projectLocalizationDoc(second))
    expect(projectLocalizationDoc(first).cells.body).toEqual({ nodes: {
      link: { props: { text: 'Lesen', href: '/de/article' }, hidden: true },
    } })
    const previous = projectLocalizationDoc(first)
    applyLocalizationDraftToDoc(first, previous, seed, LOCAL_ORIGIN)
    applyLocalizationDraftToDoc(second, previous, { ...previous, cells: { body: { nodes: { link: { props: { text: 'Lesen', href: '/de/article', title: 'Mehr erfahren' }, hidden: true } } } } }, LOCAL_ORIGIN)
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second)); Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    expect(projectLocalizationDoc(first).cells.body).toEqual({ nodes: { link: { props: { title: 'Mehr erfahren' } } } })
    expect(projectLocalizationDoc(first)).toEqual(projectLocalizationDoc(second))
    first.destroy(); second.destroy()
  })

  it('merges first translations of independent component defaults and instance parameters', () => {
    const seed: ContentLocalizationDraftInput = { cells: {}, slug: 'index' }
    const first = new Y.Doc(); seedLocalizationDoc(first, seed)
    const second = new Y.Doc(); Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    const variant = (parameter: string, value: string): ContentLocalizationDraftInput => ({ ...seed, cells: {
      parameterDefaults: { [parameter]: value },
      body: { nodes: { component: { props: { propOverrides: { [parameter]: value } } } } },
    } })
    applyLocalizationDraftToDoc(first, seed, variant('title', 'Titel'), LOCAL_ORIGIN)
    applyLocalizationDraftToDoc(second, seed, variant('label', 'Ansehen'), LOCAL_ORIGIN)
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second)); Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
    expect(projectLocalizationDoc(first)).toEqual(projectLocalizationDoc(second))
    expect(projectLocalizationDoc(first).cells).toEqual({
      parameterDefaults: { title: 'Titel', label: 'Ansehen' },
      body: { nodes: { component: { props: { propOverrides: { title: 'Titel', label: 'Ansehen' } } } } },
    })
    first.destroy(); second.destroy()
  })

})
