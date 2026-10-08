import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../../src/__tests__/helpers/capabilityHarness'
import { ContentListResultSchema, ContentSearchResultsSchema, type ContentListOptions, type ContentSearchOptions } from '@core/plugin-sdk'
import { parseValue } from '@core/utils/typeboxHelpers'
import { LocalizationError } from '@core/localization'
import { createDataRow, createDataTable, getDataRow } from '../../../repositories/data'
import { getDraftSiteDocument } from '../../../repositories/publish'
import { saveDraftSite } from '../../../repositories/site'
import { MAIN_SCOPE } from '../../../branches/scope'
import type { HostPluginRecord } from '../types'
import { workers } from '../workerState'
import { handleContentEntriesList, handleContentSearch } from './content'
import { parseApiCall } from '../../protocol/parser'

describe('localized plugin content queries', () => {
  let harness: CapabilityTestHarness
  let plugin: HostPluginRecord
  let reply: unknown

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    const { rows: [owner] } = await harness.db<{ id: string }>`SELECT id FROM users`
    const site = (await getDraftSiteDocument(harness.db, MAIN_SCOPE))!
    site.settings.localization = { catalogues: ['it', 'de'].map(language => ({ language, fileId: `language-${language}` })) }
    site.files = ['it', 'de'].map(language => ({
      id: `language-${language}`, path: `languages/${language}.json`, type: 'config' as const, createdAt: 0, updatedAt: 0,
      content: JSON.stringify({ language, messages: { entry: language === 'de'
        ? { title: 'Sicherheit', caption: 'Bildunterschrift', other: 'Zoo', secret: 'Privater Text' }
        : { title: 'Sicurezza', caption: 'Didascalia', other: 'Alfa', secret: 'Privato' } } }),
    }))
    site.files.push({ id: 'private-config', path: 'private.json', type: 'config', createdAt: 0, updatedAt: 0, content: '{"token":"private-token"}' })
    await saveDraftSite(harness.db, MAIN_SCOPE, site)
    const table = await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'plugin-articles', name: 'Articles', slug: 'articles', kind: 'postType', primaryFieldId: 'heading',
      singularLabel: 'Article', pluralLabel: 'Articles',
      fields: [{ id: 'heading', label: 'Heading', type: 'localizedText' },
        { id: 'cards', label: 'Cards', type: 'repeater', fields: [{ id: 'caption', label: 'Caption', type: 'localizedText' }] },
        { id: 'literal', label: 'Literal', type: 'text' }],
    })
    for (const id of ['visible-one', 'visible-two']) {
      await createDataRow(harness.db, MAIN_SCOPE, { id, tableId: table.id, slug: id, cells: {
        heading: { key: 'entry.title' }, cards: [{ id: 'stable-card', cells: { caption: { key: 'entry.caption' } } }],
        literal: 'entry.secret', slug: id,
      } }, owner.id)
    }
    await createDataRow(harness.db, MAIN_SCOPE, { id: 'visible-other', tableId: table.id, slug: 'visible-other',
      cells: { heading: { key: 'entry.other' }, slug: 'visible-other' } }, owner.id)
    const secret = await createDataTable(harness.db, MAIN_SCOPE, { id: 'secret-table', name: 'Secret table', slug: 'secret', kind: 'postType',
      singularLabel: 'Secret article', pluralLabel: 'Secret articles',
      fields: [{ id: 'heading', label: 'Heading', type: 'localizedText' }] })
    await createDataRow(harness.db, MAIN_SCOPE, { id: 'private-row', tableId: secret.id, slug: 'visible-private',
      cells: { heading: { key: 'entry.secret' }, title: 'Sicherheit', slug: 'visible-private' } }, owner.id)
    plugin = {
      manifest: { id: `test.localized-query-${crypto.randomUUID()}`, name: 'Localized query test', version: '1.0.0', apiVersion: 1,
        permissions: ['cms.content.read', 'cms.content.write'], grantedPermissions: ['cms.content.read', 'cms.content.write'], resources: [], adminPages: [],
        contentAccess: [{ table: 'articles', modes: ['read'] }, { table: 'secret', modes: ['write'] }] },
      assetRootPath: '/tmp/localized-query-test', routes: new Map(), hookListeners: [], hookFilters: [], loopSources: [],
      mediaAdapters: [], mediaUrlTransformers: [], inflightFetches: new Map(),
    }
    // A transport-only stub for this unique plugin; no shared function mocks.
    workers.set(plugin.manifest.id, { postMessage: (message: { value?: unknown }) => { reply = message.value } } as Worker)
    reply = undefined
  })

  afterEach(async () => {
    if (plugin?.manifest) workers.delete(plugin.manifest.id)
    if (harness) await harness.cleanup()
  })

  async function list(options: ContentListOptions = {}) {
    await handleContentEntriesList({ kind: 'api-call', target: 'cms.content.entries.list', pluginId: plugin.manifest.id,
      correlationId: 'list', args: ['articles', options] }, plugin, harness.db)
    return parseValue(ContentListResultSchema, reply)
  }

  async function search(query: string, options: ContentSearchOptions = {}) {
    await handleContentSearch({ kind: 'api-call', target: 'cms.content.search', pluginId: plugin.manifest.id,
      correlationId: 'search', args: [query, options] }, plugin, harness.db)
    return parseValue(ContentSearchResultsSchema, reply)
  }

  it('returns raw authoring references and metadata until a language is explicitly supplied', async () => {
    const metadata = await list()
    expect(metadata.localization).toEqual({ languages: ['it', 'de'], canBrowseCatalogue: false })
    expect(metadata.entries.find(row => row.id === 'visible-one')!.cells.heading).toEqual({ key: 'entry.title' })
    const german = await list({ language: 'de', filter: { heading: { like: '%SICHER%' } }, orderBy: { heading: 'asc' }, limit: 1, offset: 1 })
    expect(german.totalCount).toBe(2)
    expect(german.entries.map(row => row.id)).toEqual(['visible-two'])
    expect(german.entries[0].cells.heading).toEqual({ key: 'entry.title' })
    expect(german.localization).toEqual({ languages: ['it', 'de'], canBrowseCatalogue: false, language: 'de',
      translations: { entry: { title: 'Sicherheit', caption: 'Bildunterschrift', other: 'Zoo' } } })
    expect(JSON.stringify(german)).not.toContain('Privater Text')
    expect(JSON.stringify(german)).not.toContain('private-token')
    expect(JSON.stringify(german)).not.toContain('languages/de.json')
    expect((await getDataRow(harness.db, MAIN_SCOPE, 'visible-one'))!.cells.heading).toEqual({ key: 'entry.title' })
  })

  it('requires a language for localized comparisons while ordinary text remains literal', async () => {
    await expect(list({ filter: { heading: 'Sicherheit' } })).rejects.toBeInstanceOf(LocalizationError)
    await expect(list({ orderBy: { heading: 'asc' } })).rejects.toBeInstanceOf(LocalizationError)
    await expect(list({ language: 'fr' })).rejects.toBeInstanceOf(LocalizationError)
    expect((await list({ language: 'de', filter: { literal: 'entry.secret' } })).totalCount).toBe(2)
    expect((await list({ language: 'de', filter: { literal: 'Privater Text' } })).totalCount).toBe(0)
    expect((await list({ language: 'de', filter: { heading: { like: '%entry.title%' } } })).totalCount).toBe(0)
  })

  it('searches projected scalar/repeater text and applies the limit after table read authorization', async () => {
    const metadata = await search('Sicherheit')
    expect(metadata.results).toEqual([])
    expect(metadata.localization?.articles).toEqual({ languages: ['it', 'de'], canBrowseCatalogue: false })
    expect((await search('Sicherheit', { language: 'de', limit: 1 })).results).toHaveLength(1)
    expect((await search('Bildunterschrift', { language: 'de' })).results.map(row => row.id).sort()).toEqual(['visible-one', 'visible-two'])
    expect((await search('entry.title', { language: 'de' })).results).toEqual([])
    expect((await search('Privater', { language: 'de' })).results).toEqual([])
    expect((await search('entry.secret', { language: 'de' })).results.map(row => row.id).sort()).toEqual(['visible-one', 'visible-two'])
    const scoped = await search('visible', { language: 'de', limit: 1 })
    expect(scoped.results).toHaveLength(1)
    expect(scoped.results[0].tableSlug).toBe('articles')
    expect(scoped.localization).not.toHaveProperty('secret')
    await expect(search('visible', { language: 'fr' })).rejects.toBeInstanceOf(LocalizationError)
  })

  it('validates search/list language options through the canonical cross-VM schemas', () => {
    const base = { kind: 'api-call', pluginId: plugin.manifest.id, correlationId: 'wire' }
    expect(() => parseApiCall({ ...base, target: 'cms.content.search', args: ['query', { language: 'de', limit: 2 }] })).not.toThrow()
    expect(() => parseApiCall({ ...base, target: 'cms.content.entries.list', args: ['articles', { language: 'de' }] })).not.toThrow()
    expect(() => parseApiCall({ ...base, target: 'cms.content.search', args: ['query', 2] })).toThrow()
    expect(() => parseApiCall({ ...base, target: 'cms.content.search', args: ['query', { language: '', limit: 2 }] })).toThrow()
  })
})
