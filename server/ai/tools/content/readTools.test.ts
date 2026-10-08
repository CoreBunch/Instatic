import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../../src/__tests__/helpers/capabilityHarness'
import { createDataRow, createDataTable, getDataRow } from '../../../repositories/data'
import { getDraftSiteDocument } from '../../../repositories/publish'
import { saveDraftSite } from '../../../repositories/site'
import type { ToolContext } from '../../runtime/types'
import { LocalizationError } from '@core/localization'
import { contentReadTools } from './readTools'
import { MAIN_SCOPE } from '../../../branches/scope'

describe('content read tools', () => {
  let harness: CapabilityTestHarness

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  function context(userId: string, capabilities: ToolContext['capabilities']): ToolContext {
    return { db: harness.db, userId, capabilities, scope: 'content', branch: MAIN_SCOPE,
      conversationId: 'test', snapshot: null, signal: new AbortController().signal }
  }

  async function call(name: string, input: unknown, ctx: ToolContext) {
    const tool = contentReadTools.find(candidate => candidate.name === name)
    if (!tool?.handler) throw new Error(`Missing ${name}`)
    return tool.handler(input, ctx)
  }

  async function localizedContent() {
    await harness.setupOwner()
    const { rows: [owner] } = await harness.db.unsafe<{ id: string }>('SELECT id FROM users')
    const site = (await getDraftSiteDocument(harness.db, MAIN_SCOPE))!
    site.settings.localization = { catalogues: ['it', 'de'].map(language => ({ language, fileId: `language-${language}` })) }
    site.files = [
      { id: 'language-it', path: 'languages/it.json', type: 'config', createdAt: 0, updatedAt: 0, content: JSON.stringify({ language: 'it', messages: { entry: { title: 'Sicurezza', caption: 'Didascalia', secret: 'Privato' } } }) },
      { id: 'language-de', path: 'languages/de.json', type: 'config', createdAt: 0, updatedAt: 0, content: JSON.stringify({ language: 'de', messages: { entry: { title: 'Sicherheit', caption: 'Bildunterschrift', secret: 'Privater Text' } } }) },
      { id: 'private-source', path: 'private.json', type: 'config', createdAt: 0, updatedAt: 0, content: '{"token":"private-source-secret"}' },
    ]
    await saveDraftSite(harness.db, MAIN_SCOPE, site)
    const table = await createDataTable(harness.db, MAIN_SCOPE, { id: 'articles', name: 'Articles', slug: 'articles', kind: 'postType',
      singularLabel: 'Article', pluralLabel: 'Articles', primaryFieldId: 'heading',
      fields: [{ id: 'heading', label: 'Heading', type: 'localizedText' },
        { id: 'cards', label: 'Cards', type: 'repeater', fields: [{ id: 'caption', label: 'Caption', type: 'localizedText' }] }] })
    const row = await createDataRow(harness.db, MAIN_SCOPE, { id: 'visible', tableId: table.id, slug: 'visible-url', cells: {
      heading: { key: 'entry.title' }, cards: [{ id: 'stable-card', cells: { caption: { key: 'entry.caption' } } }], slug: 'visible-url',
    } }, owner.id)
    await createDataRow(harness.db, MAIN_SCOPE, { id: 'foreign', tableId: table.id, slug: 'foreign-url', cells: { heading: { key: 'entry.secret' }, slug: 'foreign-url' } }, owner.id)
    const persona = await harness.createRoleUser({ name: 'Own content reader', slug: 'own-content-reader',
      capabilities: ['data.custom.tables.read', 'content.edit.own'] })
    const { rows: [reader] } = await harness.db<{ id: string }>`SELECT id FROM users WHERE email = ${persona.email}`
    await harness.db`UPDATE data_rows SET author_user_id = ${reader.id} WHERE id = ${row.id}`
    return { table, row, owner, reader, ctx: context(reader.id, ['data.custom.tables.read', 'content.edit.own']) }
  }

  it('keeps collection discovery aligned with the Content workspace', async () => {
    await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'projects',
      name: 'Projects',
      slug: 'projects',
      kind: 'postType',
      routeBase: '/work',
      singularLabel: 'Project',
      pluralLabel: 'Projects',
    })
    await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'people',
      name: 'People',
      slug: 'people',
      kind: 'data',
      singularLabel: 'Person',
      pluralLabel: 'People',
    })

    const tool = contentReadTools.find(
      (candidate) => candidate.name === 'content_list_collections',
    )
    if (!tool?.handler) throw new Error('content_list_collections handler is missing')

    const result = await tool.handler({}, {
      db: harness.db,
      userId: 'owner',
      capabilities: ['data.system.tables.read', 'data.custom.tables.read'],
      scope: 'content',
      branch: MAIN_SCOPE,
      conversationId: 'test',
      snapshot: null,
      signal: new AbortController().signal,
    }) as { collections: Array<{ id: string; kind: string }> }

    expect(result.collections.map((collection) => collection.id)).toEqual([
      'posts',
      'projects',
    ])
    expect(result.collections.every((collection) => collection.kind === 'postType')).toBe(true)
  })

  it('returns metadata until a language is chosen and projects scalar and repeater values without changing references', async () => {
    const { row, table, ctx } = await localizedContent()
    const meta = await call('content_get_document', { documentId: row.id }, ctx) as { document: Record<string, unknown>; localization: unknown }
    expect(meta.localization).toEqual({ languages: ['it', 'de'], canBrowseCatalogue: false })
    expect(meta.document).not.toHaveProperty('title')
    expect(meta.document).not.toHaveProperty('fields')
    const localized = await call('content_get_document', { documentId: row.id, language: 'de' }, ctx) as { document: { title: string; fields: Record<string, unknown> }; localization: unknown }
    expect(localized.document.title).toBe('Sicherheit')
    expect(localized.document.fields.heading).toBe('Sicherheit')
    expect(localized.document.fields.cards).toEqual([{ id: 'stable-card', cells: { caption: 'Bildunterschrift' } }])
    expect(localized.localization).toEqual({ languages: ['it', 'de'], canBrowseCatalogue: false, language: 'de',
      translations: { entry: { title: 'Sicherheit', caption: 'Bildunterschrift' } } })
    expect(JSON.stringify(localized)).not.toContain('private-source')
    expect(JSON.stringify(localized)).not.toContain('Privater Text')
    expect((await getDataRow(harness.db, MAIN_SCOPE, row.id))!.cells).toEqual(row.cells)
    const list = await call('content_list_documents', { tableId: table.id, language: 'it' }, ctx) as { documents: Array<{ id: string; title: string }> }
    expect(list.documents.map(document => [document.id, document.title])).toEqual([['visible', 'Sicurezza']])
  })

  it('uses delegated table and own-row capabilities before reading a catalogue or exposing a foreign document', async () => {
    const { table, ctx, reader } = await localizedContent()
    expect(await call('content_get_document', { documentId: 'foreign', language: 'de' }, ctx)).toEqual({ ok: false, error: 'Document foreign not found.' })
    expect(await call('content_get_document', { documentId: 'does-not-exist', language: 'de' }, ctx)).toEqual({ ok: false, error: 'Document does-not-exist not found.' })
    const schema = await call('content_get_collection_schema', { tableId: table.id }, context(reader.id, ['data.system.tables.read', 'content.edit.any']))
    expect(schema).toEqual({ ok: false, error: `Collection ${table.id} not found.` })
    const empty = await call('content_list_documents', { tableId: table.id, language: 'de' }, context(reader.id, ['data.custom.tables.read', 'content.create'])) as { documents: unknown[] }
    expect(empty.documents).toEqual([])
  })

  it('searches resolved text including repeater text, never catalogue keys or inaccessible values', async () => {
    const { ctx } = await localizedContent()
    const search = async (query: string, language?: string) => call('content_search_documents', { query, language }, ctx) as Promise<{ results: Array<{ id: string; title: string }> }>
    expect((await search('Sicherheit')).results).toEqual([])
    expect((await search('Sicherheit', 'de')).results.map(row => row.id)).toEqual(['visible'])
    expect((await search('Bildunterschrift', 'de')).results.map(row => row.id)).toEqual(['visible'])
    expect((await search('entry.title', 'de')).results).toEqual([])
    expect((await search('Privater', 'de')).results).toEqual([])
    await expect(search('Sicherheit', 'fr')).rejects.toBeInstanceOf(LocalizationError)
  })

  it('names an empty ordinary row through the display-title owner without a slug or id fallback', async () => {
    const table = await createDataTable(harness.db, MAIN_SCOPE, { id: 'blank-articles', name: 'Blank articles', slug: 'blank-articles', kind: 'postType', singularLabel: 'Article', pluralLabel: 'Articles' })
    const row = await createDataRow(harness.db, MAIN_SCOPE, { id: 'internal-id', tableId: table.id, slug: 'url-only', cells: { slug: 'url-only' } })
    const result = await call('content_get_document', { documentId: row.id }, context('reader', ['data.custom.tables.read', 'content.edit.any'])) as { document: { title: string } }
    expect(result.document.title).toBe('Untitled')
  })
})
