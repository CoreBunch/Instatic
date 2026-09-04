/**
 * The God Mode completion catalogs — what each Code Dock panel knows beyond
 * its language: class names, published-site custom properties, dynamic-token
 * sources with their field schemas, and the page's real classes/ids.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { DataMeta } from '@core/data/schemas'
import { useEditorStore } from '@site/store/store'
import {
  deriveCssCompletionCatalog,
  deriveHtmlCompletionCatalog,
  deriveJsCompletionCatalog,
} from '@site/code-dock/completions'
import { resolveEntryFields, type EntryFrame } from '@site/code-editor/completionCatalog'
import '@modules/base/index'
import '@core/loops/sources'

function state() {
  return useEditorStore.getState()
}

function setup() {
  state().clearSite()
  const site = state().createSite('Completions')
  const page = site.pages[0]
  const card = state().createClass('card', { color: 'red', '--card-pad': '12px' })
  state().createClass('hero', {})
  const textId = state().insertNode('base.text', {}, page.rootNodeId)
  state().addNodeClass(textId, card.id)
  return { pageId: page.id, rootId: page.rootNodeId, textId, cardId: card.id }
}

const dataMeta: DataMeta = {
  tables: [
    {
      id: 'tbl-posts',
      slug: 'posts',
      name: 'Posts',
      kind: 'postType',
      singularLabel: 'Post',
      pluralLabel: 'Posts',
      primaryFieldId: 'title',
      routable: true,
      versioned: true,
      fields: [{ id: 'title', label: 'Title', type: 'text' }, { id: 'excerpt', label: 'Excerpt', type: 'longText' }],
    },
    {
      id: 'tbl-team',
      slug: 'team',
      name: 'Team',
      kind: 'data',
      singularLabel: 'Member',
      pluralLabel: 'Team',
      primaryFieldId: 'name',
      routable: false,
      versioned: false,
      fields: [{ id: 'name', label: 'Name', type: 'text' }],
    },
  ],
}

beforeEach(setup)

describe('deriveCssCompletionCatalog', () => {
  it('lists editable classes with usage counts and the site custom properties', () => {
    const catalog = deriveCssCompletionCatalog(state().site!)
    expect(catalog.kind).toBe('css')
    expect(catalog.classes).toEqual(
      expect.arrayContaining([
        { name: 'card', usage: 1, generated: false },
        { name: 'hero', usage: 0, generated: false },
      ]),
    )
    expect(catalog.classes.some((c) => c.generated)).toBe(false)
    expect(catalog.customProperties).toContainEqual({
      name: '--card-pad',
      value: '12px',
      origin: 'rule',
      declaredIn: '.card',
    })
  })
})

describe('deriveHtmlCompletionCatalog', () => {
  it('offers the system sources, registered loop sources, tables, and Visual Components', () => {
    const site = state().site!
    const page = site.pages[0]
    const catalog = deriveHtmlCompletionCatalog({ site, tree: page, rootId: page.rootNodeId, activePage: page, dataMeta })
    expect(catalog.tokens.systemSources.map((s) => s.id)).toEqual(['page', 'site', 'route'])
    expect(catalog.tokens.systemSources[0].fields.map((f) => f.id)).toContain('title')
    expect(catalog.tokens.loopSources['data.rows']?.fields.map((f) => f.id)).toContain('permalink')
    expect(catalog.tokens.tables.map((t) => t.id)).toEqual(['tbl-posts', 'tbl-team'])
    expect(catalog.tokens.outerEntries).toEqual([])
    expect(catalog.classes.map((c) => c.name)).toEqual(expect.arrayContaining(['card', 'hero']))
  })

  it('records the loops enclosing the projected root as outer entry frames, outermost first', () => {
    const { rootId } = setup()
    const outer = state().insertNode('base.loop', { sourceId: 'site.pages' }, rootId)
    const inner = state().insertNode('base.loop', { sourceId: 'data.rows', filters: { tableId: 'tbl-posts' } }, outer)
    const leaf = state().insertNode('base.text', {}, inner)
    const site = state().site!
    const page = site.pages[0]
    const catalog = deriveHtmlCompletionCatalog({ site, tree: page, rootId: leaf, activePage: page, dataMeta })
    expect(catalog.tokens.outerEntries).toEqual([
      { kind: 'loop', sourceId: 'site.pages', tableId: null },
      { kind: 'loop', sourceId: 'data.rows', tableId: 'tbl-posts' },
    ])
    // The root itself is inside the document, so it is not an outer frame.
    const atInner = deriveHtmlCompletionCatalog({ site, tree: page, rootId: inner, activePage: page, dataMeta })
    expect(atInner.tokens.outerEntries).toEqual([{ kind: 'loop', sourceId: 'site.pages', tableId: null }])
  })

  it('puts a template page entry before the enclosing loops', () => {
    const { rootId, pageId } = setup()
    const loop = state().insertNode('base.loop', { sourceId: 'site.pages' }, rootId)
    useEditorStore.setState((s) => {
      const page = s.site!.pages.find((p) => p.id === pageId)!
      page.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 }
    })
    const site = state().site!
    const page = site.pages[0]
    const catalog = deriveHtmlCompletionCatalog({ site, tree: page, rootId: loop, activePage: page, dataMeta })
    expect(catalog.tokens.outerEntries).toEqual([{ kind: 'template', tableSlug: 'posts' }])
  })
})

describe('resolveEntryFields', () => {
  function tokens(outerEntries: EntryFrame[]) {
    const site = state().site!
    const page = site.pages[0]
    return {
      ...deriveHtmlCompletionCatalog({ site, tree: page, rootId: page.rootNodeId, activePage: page, dataMeta }).tokens,
      outerEntries,
    }
  }

  it('offers no entry sources outside any loop or template', () => {
    expect(resolveEntryFields(tokens([]), [])).toEqual({ currentEntry: null, parentEntry: null })
  })

  it('resolves a table-bound loop to the table fields plus the loop metadata the table lacks', () => {
    const { currentEntry, parentEntry } = resolveEntryFields(tokens([]), [
      { kind: 'loop', sourceId: 'data.rows', tableId: 'tbl-posts' },
    ])
    const ids = currentEntry!.map((f) => f.id)
    expect(ids.slice(0, 2)).toEqual(['title', 'excerpt'])
    expect(ids).toContain('permalink')
    expect(ids).toContain('body')
    expect(ids.filter((id) => id === 'title')).toHaveLength(1)
    expect(parentEntry).toBeNull()
  })

  it('hides post-type-only loop metadata for a data-kind table', () => {
    const { currentEntry } = resolveEntryFields(tokens([]), [
      { kind: 'loop', sourceId: 'data.rows', tableId: 'tbl-team' },
    ])
    const ids = currentEntry!.map((f) => f.id)
    expect(ids).toContain('name')
    expect(ids).toContain('permalink')
    expect(ids).not.toContain('body')
    expect(ids).not.toContain('featuredMedia')
  })

  it('falls back to the source schema when the loop has no table, and to nothing for an unknown source', () => {
    expect(resolveEntryFields(tokens([]), [{ kind: 'loop', sourceId: 'site.pages', tableId: null }]).currentEntry!.map((f) => f.id))
      .toContain('title')
    expect(resolveEntryFields(tokens([]), [{ kind: 'loop', sourceId: 'acme.unknown', tableId: null }]).currentEntry).toEqual([])
  })

  it('stacks outer frames under inner ones: parentEntry is the frame below the innermost', () => {
    const { currentEntry, parentEntry } = resolveEntryFields(
      tokens([{ kind: 'template', tableSlug: 'team' }]),
      [{ kind: 'loop', sourceId: 'data.rows', tableId: 'tbl-posts' }],
    )
    expect(currentEntry!.map((f) => f.id)).toContain('excerpt')
    expect(parentEntry!.map((f) => f.id)).toContain('name')
    expect(parentEntry!.map((f) => f.id)).toContain('permalink')
  })
})

describe('deriveJsCompletionCatalog', () => {
  it('lists the page classes and ids with the selected element first', () => {
    const { rootId, textId } = setup()
    const other = state().insertNode('base.container', { htmlAttributes: { id: 'hero' } }, rootId)
    const hero = state().site!.styleRules[Object.keys(state().site!.styleRules).find((id) => state().site!.styleRules[id].name === 'hero')!]
    state().addNodeClass(other, hero.id)
    state().updateNodeProps(textId, { htmlAttributes: { id: 'intro' } })
    const site = state().site!
    const page = site.pages[0]
    const unselected = deriveJsCompletionCatalog({ site, tree: page, selectedNodeId: null })
    expect(unselected).toEqual({ kind: 'js', classes: ['card', 'hero'], ids: ['intro', 'hero'], selectedClasses: [], selectedIds: [] })
    const selected = deriveJsCompletionCatalog({ site, tree: page, selectedNodeId: other })
    expect(selected.classes).toEqual(['hero', 'card'])
    expect(selected.ids).toEqual(['hero', 'intro'])
    expect(selected.selectedClasses).toEqual(['hero'])
    expect(selected.selectedIds).toEqual(['hero'])
  })
})
