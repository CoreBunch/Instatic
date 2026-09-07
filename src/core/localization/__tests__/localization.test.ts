import { describe, expect, it } from 'bun:test'
import { create } from 'mutative'
import type { DataField } from '@core/data/schemas'
import type { BaseNode, Page } from '@core/page-tree'
import type { LocaleTreeOverrides } from '@core/localization-schema'
import {
  createTranslationFieldMetadata,
  extractLocalizedTreeChanges,
  getLocalizablePropertyKeys,
  getTranslationFieldState,
  LocalizationValidationError,
  materializeLocalizedCells,
  materializeLocalizedTree,
  parseLocaleTreeCell,
  resetLocalizedNodeProperty,
  resolveDataFieldLocalization,
  splitLocalizedCells,
  splitLocalizedTree,
  translationSourceFingerprint,
  updateTranslationMetadata,
} from '../index'

function page(): Page {
  return {
    id: 'page', slug: 'index', title: 'Home', rootNodeId: 'root',
    nodes: {
      root: { id: 'root', moduleId: 'base.body', props: {}, children: ['heading'], classIds: [], breakpointOverrides: {}, parentId: null },
      heading: {
        id: 'heading', moduleId: 'base.text', props: { text: 'Baseline', htmlTag: 'h1', description: 'Inherited description' },
        children: [], classIds: ['headingClass'], breakpointOverrides: {}, parentId: 'root',
      },
    },
  }
}

function contentProperty(_node: BaseNode, key: string): boolean {
  return ['text', 'description', 'alt', 'href'].includes(key)
}

const fields: DataField[] = [
  { id: 'title', type: 'text', label: 'Title', localization: 'localized' },
  { id: 'description', type: 'longText', label: 'Description', localization: 'localized' },
  { id: 'price', type: 'number', label: 'Price', localization: 'shared' },
  { id: 'available', type: 'boolean', label: 'Available', localization: 'localized' },
  { id: 'photos', type: 'media', label: 'Photos', allowMultiple: true, localization: 'localized' },
]
const bodyField: DataField = { id: 'body', type: 'pageTree', label: 'Body' }

describe('localized tree projections', () => {
  it('keeps one structure and Page metadata while source and target values compose independently', () => {
    const shared = page()
    const source = { heading: { props: { text: 'Hello', description: 'Source description' }, hidden: true } }
    const target = { heading: { props: { text: 'Hallo' }, hidden: false } }
    const projected = materializeLocalizedTree(shared, source, target)
    expect(projected.id).toBe(shared.id)
    expect(projected.nodes.root.children).toEqual(['heading'])
    expect(projected.nodes.heading.props).toEqual({ text: 'Hallo', description: 'Source description', htmlTag: 'h1' })
    expect(projected.nodes.heading.hidden).toBe(false)
    expect(shared.nodes.heading.props.text).toBe('Baseline')
    expect(source.heading.props.text).toBe('Hello')
  })

  it('does not share mutable nested values with the tree or override source', () => {
    const shared = page()
    shared.nodes.heading.props.items = [{ text: 'Base' }]
    const target = { heading: { props: { media: ['image-a'] } } }
    const projected = materializeLocalizedTree(shared, {}, target)
    const items = projected.nodes.heading.props.items
    const media = projected.nodes.heading.props.media
    if (Array.isArray(items)) items.push({ text: 'Changed' })
    if (Array.isArray(media)) media.push('image-b')
    projected.nodes.root.children.push('detached')
    expect(shared.nodes.heading.props.items).toEqual([{ text: 'Base' }])
    expect(target.heading.props.media).toEqual(['image-a'])
    expect(shared.nodes.root.children).toEqual(['heading'])
  })

  it('can compose safely from Mutative draft proxies', () => {
    const shared = page()
    create(shared, (draft) => {
      const projected = materializeLocalizedTree(draft, { heading: { props: { text: 'Source' } } })
      projected.nodes.heading.props.text = 'Projection edit'
      expect(draft.nodes.heading.props.text).toBe('Baseline')
    })
  })

  it('does not invent nodes for stale overrides after shared structure deletion', () => {
    const projected = materializeLocalizedTree(page(), {}, { deleted: { props: { text: 'Stale' } } })
    expect(projected.nodes.deleted).toBeUndefined()
    expect(Object.keys(projected.nodes)).toHaveLength(2)
  })

  it('captures only edited values so untouched properties continue inheriting future changes', () => {
    const shared = page()
    const source = { heading: { props: { text: 'Hello', description: 'Original description' } } }
    const before = materializeLocalizedTree(shared, source)
    const after = materializeLocalizedTree(before)
    after.nodes.heading.props.text = 'Hallo'
    const localized = extractLocalizedTreeChanges(before, after, {}, contentProperty)
    expect(localized).toEqual({ heading: { props: { text: 'Hallo' } } })
    const changedSource = { heading: { props: { text: 'New English', description: 'Updated description' } } }
    const next = materializeLocalizedTree(shared, changedSource, localized)
    expect(next.nodes.heading.props.text).toBe('Hallo')
    expect(next.nodes.heading.props.description).toBe('Updated description')
  })

  it('retains an explicit translation equal to the source until reset is requested', () => {
    const shared = page()
    const source = { heading: { props: { text: 'Brand name' } } }
    const previous = { heading: { props: { text: 'Translated name' } } }
    const before = materializeLocalizedTree(shared, source, previous)
    const after = materializeLocalizedTree(before)
    after.nodes.heading.props.text = 'Brand name'
    const local = extractLocalizedTreeChanges(before, after, previous, contentProperty)
    expect(local.heading.props?.text).toBe('Brand name')
    expect(resetLocalizedNodeProperty(local, 'heading', 'text')).toEqual({})
    expect(resetLocalizedNodeProperty({ heading: { hidden: true } }, 'heading', 'hidden')).toEqual({})
    expect(resetLocalizedNodeProperty({ heading: { hidden: false, props: { text: 'Keep copy' } } }, 'heading', 'hidden')).toEqual({ heading: { props: { text: 'Keep copy' } } })
    expect(local.heading.props?.text).toBe('Brand name')
  })

  it('preserves intentional empty/null overrides and explicit visible overrides', () => {
    const before = materializeLocalizedTree(page(), { heading: { hidden: true } })
    const after = materializeLocalizedTree(before)
    after.nodes.heading.props.text = ''
    after.nodes.heading.props.description = null
    after.nodes.heading.hidden = false
    expect(extractLocalizedTreeChanges(before, after, {}, contentProperty)).toEqual({
      heading: { props: { text: '', description: null }, hidden: false },
    })
  })

  it('treats deleting an override as reset instead of persisting undefined', () => {
    const previous = { heading: { props: { text: 'Hallo' }, hidden: true } }
    const before = materializeLocalizedTree(page(), {}, previous)
    const after = materializeLocalizedTree(before)
    delete after.nodes.heading.props.text
    delete after.nodes.heading.hidden
    expect(extractLocalizedTreeChanges(before, after, previous, contentProperty)).toEqual({})
  })

  it('rejects structural, design, binding and shared property edits in translation mode', () => {
    const before = page()
    for (const change of [
      (p: Page) => { p.nodes.root.children = [] },
      (p: Page) => { delete p.nodes.heading },
      (p: Page) => { p.nodes.heading.moduleId = 'base.image' },
      (p: Page) => { p.nodes.heading.classIds = [] },
      (p: Page) => { p.nodes.heading.dynamicBindings = { text: { source: 'currentEntry', field: 'title' } } },
      (p: Page) => { p.nodes.heading.props.htmlTag = 'h2' },
    ]) {
      const after = materializeLocalizedTree(before)
      change(after)
      expect(() => extractLocalizedTreeChanges(before, after, {}, contentProperty)).toThrow(LocalizationValidationError)
    }
  })

  it('validates sparse tree cells and rejects independent layout trees', () => {
    expect(parseLocaleTreeCell(undefined)).toEqual({ nodes: {} })
    expect(parseLocaleTreeCell({ nodes: { heading: { props: { text: null }, hidden: false } } })).toEqual({
      nodes: { heading: { props: { text: null }, hidden: false } },
    })
    for (const invalid of [null, page(), { nodes: { heading: { children: [] } } }, { nodes: { heading: { hidden: 'yes' } } }]) {
      expect(() => parseLocaleTreeCell(invalid)).toThrow(LocalizationValidationError)
    }
  })

  it('derives content properties through nested groups and excludes hidden publisher fields', () => {
    const keys = getLocalizablePropertyKeys({
      htmlTag: { type: 'select', label: 'Tag', options: [] },
      title: { type: 'text', label: 'Title' },
      injected: { type: 'richtext', label: 'Content', hidden: true },
      content: { type: 'group', label: 'Content', children: {
        alt: { type: 'text', label: 'Alt' },
        appearance: { type: 'group', label: 'Appearance', children: {
          category: { type: 'select', label: 'Category', category: 'content', options: [] },
        } },
      } },
    })
    expect([...keys]).toEqual(['title', 'alt', 'category'])
  })
})

describe('source structure authoring', () => {
  it('separates source copy changes from shared design changes without overwriting baseline copy', () => {
    const shared = page()
    const previous = { heading: { props: { text: 'Source copy' } } }
    const before = materializeLocalizedTree(shared, previous)
    const after = materializeLocalizedTree(before)
    after.nodes.heading.props.text = 'Revised copy'
    after.nodes.heading.props.htmlTag = 'h2'
    after.nodes.heading.classIds = ['newClass']
    const split = splitLocalizedTree(shared, before, after, previous, contentProperty)
    expect(split.sharedTree.nodes.heading.props.text).toBe('Baseline')
    expect(split.sharedTree.nodes.heading.props.htmlTag).toBe('h2')
    expect(split.sharedTree.nodes.heading.classIds).toEqual(['newClass'])
    expect(split.localeOverrides).toEqual({ heading: { props: { text: 'Revised copy' } } })
    expect(materializeLocalizedTree(split.sharedTree, split.localeOverrides)).toEqual(after)
  })

  it('stores localized values of new nodes in source overrides and prunes removed node overrides', () => {
    const shared = page()
    const previous: LocaleTreeOverrides = { heading: { props: { text: 'Source' } }, removed: { props: { text: 'Old' } } }
    const before = materializeLocalizedTree(shared, previous)
    const after = materializeLocalizedTree(before)
    after.nodes.new = { ...after.nodes.heading, id: 'new', props: { text: 'New copy', htmlTag: 'p' }, hidden: false }
    after.nodes.root.children.push('new')
    const split = splitLocalizedTree(shared, before, after, previous, contentProperty)
    expect(split.sharedTree.nodes.new.props).toEqual({ htmlTag: 'p' })
    expect(split.sharedTree.nodes.new.hidden).toBeUndefined()
    expect(split.localeOverrides.new).toEqual({ props: { text: 'New copy' }, hidden: false })
    expect(split.localeOverrides.removed).toBeUndefined()
    expect(materializeLocalizedTree(split.sharedTree, split.localeOverrides)).toEqual(after)
  })
})

describe('localized CMS cells', () => {
  it('honors explicit field mode and concrete zero/false/empty/null target values', () => {
    expect(resolveDataFieldLocalization({ id: 'n', type: 'number', label: 'Number', localization: 'localized' })).toBe('localized')
    expect(resolveDataFieldLocalization({ id: 't', type: 'text', label: 'Shared', localization: 'shared' })).toBe('shared')
    const shared = { price: 12, title: 'Old logical title', technicalMetadata: { id: 'stable' } }
    const source = { title: 'Source', description: 'Source description', available: true, photos: ['image'], price: 300 }
    const local = { title: '', description: null, available: false, photos: [], price: 999, technicalMetadata: 'Bad override' }
    expect(materializeLocalizedCells(fields, shared, source, local)).toEqual({
      title: '', description: null, available: false, photos: [], price: 12, technicalMetadata: { id: 'stable' },
    })
  })

  it('does not resurrect stale localized logical values and distinguishes missing from explicit null', () => {
    const projected = materializeLocalizedCells(fields, { title: 'Old value' }, { description: 'Source' }, { title: null })
    expect(projected).toEqual({ title: null, description: 'Source' })
    expect(Object.hasOwn(projected, 'available')).toBe(false)
    expect(materializeLocalizedCells(fields, { title: 'Old value' }, {}, {})).toEqual({})
  })

  it('materializes page-tree fields identically for the source locale and target locale', () => {
    const shared = { body: page() }
    const source = { body: { nodes: { heading: { props: { text: 'Hello' } } } } }
    const local = { body: { nodes: { heading: { props: { text: 'Hallo' } } } } }
    expect(materializeLocalizedCells([bodyField], shared, source, source).body).toEqual(materializeLocalizedTree(page(), source.body.nodes))
    expect(materializeLocalizedCells([bodyField], shared, source, local).body).toEqual(materializeLocalizedTree(page(), source.body.nodes, local.body.nodes))
    expect(() => materializeLocalizedCells([bodyField], shared, source, { body: page() })).toThrow(LocalizationValidationError)
  })

  it('splits edited cells without freezing inherited values or losing technical shared metadata', () => {
    const shared = { price: 12, technicalMetadata: { id: 'keep' } }
    const source = { title: 'Hello', description: 'Source description' }
    const previous = materializeLocalizedCells(fields, shared, source, {})
    const next = { ...previous, title: 'Hallo', price: 15, injected: 'ignore' }
    const split = splitLocalizedCells(fields, shared, previous, next, {})
    expect(split.sharedCells).toEqual({ price: 15, technicalMetadata: { id: 'keep' } })
    expect(split.localeCells).toEqual({ title: 'Hallo' })
    expect(materializeLocalizedCells(fields, split.sharedCells, { ...source, description: 'Updated source' }, split.localeCells).description).toBe('Updated source')
  })

  it('writes authored values on a new item and supports resetting an existing local value', () => {
    const authored = { title: '', description: null, price: 0, available: false }
    expect(splitLocalizedCells(fields, {}, {}, authored, {})).toEqual({
      sharedCells: { price: 0 }, localeCells: { title: '', description: null, available: false },
    })
    const split = splitLocalizedCells(fields, {}, { title: 'Hallo' }, {}, { title: 'Hallo' })
    expect(split.localeCells).toEqual({})
  })

  it('splits body edits using the same sparse translation rules and refuses unrestricted tree writes', () => {
    const shared = { body: page() }
    const before = page()
    const after = materializeLocalizedTree(before)
    after.nodes.heading.props.text = 'Hallo'
    expect(() => splitLocalizedCells([bodyField], shared, { body: before }, { body: after }, {})).toThrow(LocalizationValidationError)
    const split = splitLocalizedCells([bodyField], shared, { body: before }, { body: after }, {}, { canLocalizeProperty: contentProperty })
    expect(split.sharedCells).toEqual(shared)
    expect(split.localeCells).toEqual({ body: { nodes: { heading: { props: { text: 'Hallo' } } } } })
  })

  it('can create a shared body with sparse primary values without storing duplicate trees', () => {
    const tree = page()
    const split = splitLocalizedCells([bodyField], {}, {}, { body: tree }, {}, {
      canLocalizeProperty: contentProperty, allowStructureChanges: true,
    })
    expect(split.localeCells.body).toEqual({ nodes: { heading: { props: { text: 'Baseline', description: 'Inherited description' } } } })
    expect(materializeLocalizedCells([bodyField], split.sharedCells, split.localeCells, split.localeCells).body).toEqual(tree)
  })
})

describe('translation source review', () => {
  it('fingerprints semantic source content independently of object key order', () => {
    expect(translationSourceFingerprint({ title: 'Hello', nested: { a: 1, b: 2 } })).toBe(
      translationSourceFingerprint({ nested: { b: 2, a: 1 }, title: 'Hello' }),
    )
    expect(translationSourceFingerprint(['a', 'b'])).not.toBe(translationSourceFingerprint(['b', 'a']))
    expect(new Set([undefined, null, '', false, 0, [], {}].map(translationSourceFingerprint)).size).toBe(7)
  })

  it('turns reviewed translations into needs-review when their source changes without replacing copy', () => {
    const source = { title: 'Hello' }
    const localized = { title: 'Hallo' }
    const meta = createTranslationFieldMetadata(source.title, 'reviewed')
    expect(getTranslationFieldState(source, localized, 'title', meta)).toBe('reviewed')
    expect(getTranslationFieldState({ title: 'New source' }, localized, 'title', meta)).toBe('needs_review')
    expect(localized.title).toBe('Hallo')
    expect(meta.reviewState).toBe('reviewed')
  })

  it('distinguishes missing, inherited and intentional empty translations', () => {
    expect(getTranslationFieldState({}, {}, 'title')).toBe('missing')
    expect(getTranslationFieldState({ title: null }, {}, 'title')).toBe('inherited')
    expect(getTranslationFieldState({ title: 'Hello' }, { title: '' }, 'title')).toBe('needs_review')
    expect(getTranslationFieldState({ title: 'Hello' }, { title: null }, 'title')).toBe('needs_review')
  })

  it('updates source metadata only for edited translations and removes it on reset', () => {
    const title = createTranslationFieldMetadata('Original title', 'reviewed')
    const body = createTranslationFieldMetadata('Original body', 'reviewed')
    const previous = { title, body }
    const next = updateTranslationMetadata(
      { title: 'New title', body: 'New body' },
      { title: 'Alter Titel', body: 'Alter Text' },
      { title: 'Alter Titel', body: 'Neuer Text' },
      previous,
    )
    expect(next.title).toEqual(title)
    expect(next.body).toEqual(createTranslationFieldMetadata('New body'))
    expect(previous.body).toEqual(body)
    expect(updateTranslationMetadata({}, { title: 'Reset' }, {}, { title })).toEqual({})
  })
})
