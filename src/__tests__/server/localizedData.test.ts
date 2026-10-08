import { afterEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { createDataTable, createDataRow, getDataRow, getDataTable, saveDataRowDraft, updateDataRowTable } from '../../../server/repositories/data'
import { getDraftSiteDocument } from '../../../server/repositories/publish'
import { saveDraftSite } from '../../../server/repositories/site'
import { findUserById } from '../../../server/repositories/users'
import { assertLocalizedDataImport, assertLocalizedDataWrite } from '../../../server/repositories/data/localization'
import { LocalizedDataReferenceAccessError } from '@core/data/localizedCells'
import { DataLocalizationSchema } from '@core/data/schemas'
import { LocalizationError } from '@core/localization'
import { parseValue } from '@core/utils/typeboxHelpers'
import { fetchPublishedDataRowItems } from '@core/loops/sources/dataRows'
import type { DataRowCells, DataTable } from '@core/data/schemas'
import type { SiteBundle } from '@core/data/bundleSchema'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { getPublishVersion } from '../../../server/publish/publishState'
import { pageToCells } from '@core/data/pageFromRow'
import { createNode } from '@core/page-tree'
import { applyBranchMerge, undoBranchMerge } from '../../../server/branches/merge'

let harness: CapabilityTestHarness | undefined
afterEach(async () => { await harness?.cleanup(); harness = undefined })
const title = { id: 'heading', label: 'Heading', type: 'localizedText' } as const
const messages = {
  it: { entry: { a: 'Zebra italiana', b: 'Albero italiano', private: 'Testo privato', history: 'Titolo precedente' } },
  de: { entry: { a: 'Apfel Deutsch', b: 'Zebra Deutsch', private: 'Privater Text', history: 'Vorheriger Titel' } },
}

async function setup() {
  harness = await createCapabilityTestHarness()
  const ownerCookie = await harness.setupOwner()
  const { rows: [{ id: ownerId }] } = await harness.db.unsafe<{ id: string }>('SELECT id FROM users')
  const site = (await getDraftSiteDocument(harness.db, MAIN_SCOPE))!
  site.settings.language = 'it'
  site.settings.localization = { catalogues: ['it', 'de'].map(language => ({ language, fileId: `language-${language}` })) }
  site.files = Object.entries(messages).map(([language, dictionary]) => ({ id: `language-${language}`, path: `languages/${language}.json`, type: 'config', createdAt: 0, updatedAt: 0, content: JSON.stringify({ language, messages: dictionary }) }))
  site.files.push({ id: 'private-config', path: 'private.json', type: 'config', createdAt: 0, updatedAt: 0, content: '{"secret":"do not disclose"}' })
  await saveDraftSite(harness.db, MAIN_SCOPE, site)
  const table = await createDataTable(harness.db, MAIN_SCOPE, { id: 'localized-entries', name: 'Entries', slug: 'entries', singularLabel: 'Entry', pluralLabel: 'Entries', fields: [title], primaryFieldId: title.id })
  return { harness, ownerCookie, ownerId, site, table }
}

async function write(table: DataTable, cells: DataRowCells, actor: string | null = null, id = crypto.randomUUID()) {
  return createDataRow(harness!.db, MAIN_SCOPE, { id, tableId: table.id, slug: '', cells }, actor)
}

async function dataPersona() {
  const persona = await harness!.createRoleUser({ name: 'Own data editor', slug: `own-data-${crypto.randomUUID()}`, capabilities: ['content.create', 'content.edit.own', 'data.custom.tables.read', 'data.custom.tables.manage', 'data.import'] })
  const { rows: [row] } = await harness!.db<{ id: string }>`SELECT id FROM users WHERE email = ${persona.email}`
  const user = (await findUserById(harness!.db, row.id))!
  return { ...persona, user }
}

describe('native localized data access and writes', () => {
  it('requires an explicit language and never returns source files or private unreferenced text to a Data-only author', async () => {
    const { table } = await setup()
    const persona = await dataPersona()
    await write(table, { heading: { key: 'entry.a' } }, null, 'owned')
    await harness!.db`UPDATE data_rows SET author_user_id = ${persona.user.id} WHERE id = ${'owned'}`
    await write(table, { heading: { key: 'entry.private' } }, null, 'foreign')
    const meta = await harness!.cms(`/admin/api/cms/data/localization?table=${table.id}`, { cookie: persona.cookie })
    expect(meta.status).toBe(200)
    expect(parseValue(DataLocalizationSchema, await meta.json())).toEqual({ languages: ['it', 'de'], canBrowseCatalogue: false })
    const response = await harness!.cms(`/admin/api/cms/data/localization?table=${table.id}&language=de`, { cookie: persona.cookie })
    expect(response.status).toBe(200)
    const projected = parseValue(DataLocalizationSchema, await response.json())
    expect(projected).toEqual({ languages: ['it', 'de'], canBrowseCatalogue: false, language: 'de', translations: { entry: { a: 'Apfel Deutsch' } } })
    expect(JSON.stringify(projected)).not.toContain('private')
    expect(JSON.stringify(projected)).not.toContain('files')
    expect((await getDataRow(harness!.db, MAIN_SCOPE, 'owned'))!.cells.heading).toEqual({ key: 'entry.a' })
  })

  it('restricts catalogue browsing by Site permission and rejects unknown tables, language and missing configuration', async () => {
    const { table, ownerCookie, site } = await setup()
    const response = await harness!.cms(`/admin/api/cms/data/localization?table=${table.id}&language=it`, { cookie: ownerCookie })
    expect(response.status).toBe(200)
    expect((parseValue(DataLocalizationSchema, await response.json()).translations?.entry as object)).toEqual(messages.it.entry)
    expect((await harness!.cms('/admin/api/cms/data/localization?table=missing&language=it', { cookie: ownerCookie })).status).toBe(404)
    expect((await harness!.cms(`/admin/api/cms/data/localization?table=${table.id}&language=fr`, { cookie: ownerCookie })).status).toBe(422)
    delete site.settings.localization
    await saveDraftSite(harness!.db, MAIN_SCOPE, site)
    expect((await harness!.cms(`/admin/api/cms/data/localization?table=${table.id}`, { cookie: ownerCookie })).status).toBe(422)
  })

  it('prevents a writer oracle before mutation and allows reuse of authorized keys', async () => {
    const { table } = await setup()
    const persona = await dataPersona()
    await write(table, { heading: { key: 'entry.a' } }, null, 'owned')
    await harness!.db`UPDATE data_rows SET author_user_id = ${persona.user.id} WHERE id = ${'owned'}`
    const endpoint = `/admin/api/cms/data/rows/owned`
    const forbidden = await harness!.cms(endpoint, { method: 'PATCH', cookie: persona.cookie, json: { cells: { heading: { key: 'entry.private' } } } })
    expect(forbidden.status).toBe(403)
    expect((await getDataRow(harness!.db, MAIN_SCOPE, 'owned'))!.cells.heading).toEqual({ key: 'entry.a' })
    const unknown = await harness!.cms(endpoint, { method: 'PATCH', cookie: persona.cookie, json: { cells: { heading: { key: 'entry.doesNotExist' } } } })
    expect(unknown.status).toBe(403)
    expect(await readJson<{ error: string }>(unknown)).toEqual(await readJson<{ error: string }>(forbidden))
    const reused = await harness!.cms(`/admin/api/cms/data/tables/${table.id}/rows`, { method: 'POST', cookie: persona.cookie, json: { cells: { heading: { key: 'entry.a' } } } })
    expect(reused.status).toBe(201)
    const malformed = await harness!.cms(endpoint, { method: 'PATCH', cookie: persona.cookie, json: { cells: { heading: { key: 'entry.a', text: 'embedded' } } } })
    expect(malformed.status).toBe(422)
  })

  it('checks schema reclassification and import before any key can be exposed', async () => {
    const { table } = await setup()
    const persona = await dataPersona()
    await harness!.db`UPDATE data_tables SET fields_json = ${[{ id: title.id, type: 'text', label: title.label }]} WHERE id = ${table.id}`
    await write((await getDataTable(harness!.db, MAIN_SCOPE, table.id))!, { heading: { key: 'entry.private' } }, null, 'schema-oracle')
    await expect(assertLocalizedDataWrite(harness!.db, MAIN_SCOPE, [title], { heading: { key: 'entry.private' } }, persona.user.id, null, 'rows.schema-oracle.cells')).rejects.toBeInstanceOf(LocalizedDataReferenceAccessError)
    const patch = await harness!.cms(`/admin/api/cms/data/tables/${table.id}`, { method: 'PATCH', cookie: await harness!.stepUp(persona.cookie), json: { fields: [title] } })
    expect(patch.status).toBe(403)
    expect((await getDataTable(harness!.db, MAIN_SCOPE, table.id))!.fields[0].type).toBe('text')
    const row = (await getDataRow(harness!.db, MAIN_SCOPE, 'schema-oracle'))!
    const bundle: SiteBundle = { schemaVersion: 1, exportedAt: new Date().toISOString(), tables: [table], rows: [row] }
    await expect(assertLocalizedDataImport(harness!.db, MAIN_SCOPE, persona.user, bundle, 'merge-overwrite')).rejects.toBeInstanceOf(LocalizedDataReferenceAccessError)
    await expect(assertLocalizedDataImport(harness!.db, MAIN_SCOPE, persona.user, { ...bundle, rows: [] }, 'merge-overwrite')).rejects.toBeInstanceOf(LocalizedDataReferenceAccessError)
    expect((await getDataRow(harness!.db, MAIN_SCOPE, row.id))!.cells.heading).toEqual({ key: 'entry.private' })
  })

  it('validates retained history when a field is reclassified, without disclosing private row identities', async () => {
    const { table } = await setup()
    const persona = await dataPersona()
    await harness!.db`UPDATE data_tables SET fields_json = ${[{ id: title.id, type: 'text', label: title.label }]} WHERE id = ${table.id}`
    await write((await getDataTable(harness!.db, MAIN_SCOPE, table.id))!, { heading: null }, null, 'hidden-row')
    await harness!.db`INSERT INTO data_row_versions(id,row_id,version_number,cells_json,slug) VALUES (${'hidden-version'},${'hidden-row'},${1},${{ heading: { key: 'entry.private' } }},${''})`
    const patch = await harness!.cms(`/admin/api/cms/data/tables/${table.id}`, { method: 'PATCH', cookie: await harness!.stepUp(persona.cookie), json: { fields: [title] } })
    expect(patch.status).toBe(403)
    expect(JSON.stringify(await patch.json())).not.toContain('hidden-row')
    expect((await getDataTable(harness!.db, MAIN_SCOPE, table.id))!.fields[0].type).toBe('text')
  })

  it('uses the catalogue actually adopted by each import strategy and validates all retained references', async () => {
    const { table, ownerId, site } = await setup()
    await write(table, { heading: { key: 'entry.a' } }, ownerId, 'retained')
    const owner = (await findUserById(harness!.db, ownerId))!
    const invalidSite = structuredClone(site)
    invalidSite.files = invalidSite.files.map(file => file.id.startsWith('language-') ? { ...file, content: JSON.stringify({ language: file.id.slice(9), messages: { entry: { b: 'Only B' } } }) } : file)
    const bundle: SiteBundle = { schemaVersion: 1, exportedAt: new Date().toISOString(), site: invalidSite, tables: [], rows: [] }
    await expect(assertLocalizedDataImport(harness!.db, MAIN_SCOPE, owner, bundle, 'merge-overwrite')).rejects.toBeInstanceOf(LocalizationError)
    await expect(assertLocalizedDataImport(harness!.db, MAIN_SCOPE, owner, bundle, 'merge-add')).resolves.toBeUndefined()
    expect((await getDataRow(harness!.db, MAIN_SCOPE, 'retained'))!.cells.heading).toEqual({ key: 'entry.a' })
  })

  it('allows authorized history references and blocks a plugin from introducing a foreign key', async () => {
    const { table } = await setup()
    const persona = await dataPersona()
    await write(table, { heading: { key: 'entry.a' } }, null, 'owned')
    await harness!.db`UPDATE data_rows SET author_user_id = ${persona.user.id} WHERE id = ${'owned'}`
    await harness!.db`INSERT INTO data_row_versions(id,row_id,version_number,cells_json,slug) VALUES (${'owned-v1'},${'owned'},${1},${{ heading: { key: 'entry.history' } }},${''})`
    await saveDataRowDraft(harness!.db, MAIN_SCOPE, 'owned', { cells: { heading: { key: 'entry.history' } }, slug: '' }, persona.user.id)
    expect((await getDataRow(harness!.db, MAIN_SCOPE, 'owned'))!.cells.heading).toEqual({ key: 'entry.history' })
    await expect(createDataRow(harness!.db, MAIN_SCOPE, { tableId: table.id, slug: '', cells: { heading: { key: 'entry.private' } } }, null, 'plugin-example')).rejects.toBeInstanceOf(LocalizedDataReferenceAccessError)
    const pluginRow = await createDataRow(harness!.db, MAIN_SCOPE, { tableId: table.id, slug: '', cells: { heading: { key: 'entry.history' } } }, null, 'plugin-example')
    expect(pluginRow.cells.heading).toEqual({ key: 'entry.history' })
  })

  it('enforces the plugin target-table key authority when moving a row or its history', async () => {
    const { table } = await setup()
    const source = await createDataTable(harness!.db, MAIN_SCOPE, { id: 'ordinary', name: 'Ordinary', slug: 'ordinary', singularLabel: 'Entry', pluralLabel: 'Entries', fields: [{ ...title, type: 'text' }] })
    await write(table, { heading: { key: 'entry.a' } }, null, 'authorized-target')
    const foreign = await write(source, { heading: { key: 'entry.private' } }, null, 'foreign-source')
    await expect(updateDataRowTable(harness!.db, MAIN_SCOPE, foreign.id, table.id, null, 'plugin-example')).rejects.toBeInstanceOf(LocalizedDataReferenceAccessError)
    expect((await getDataRow(harness!.db, MAIN_SCOPE, foreign.id))!.tableId).toBe(source.id)
    const historic = await write(source, { heading: null }, null, 'historic-source')
    await harness!.db`INSERT INTO data_row_versions(id,row_id,version_number,cells_json,slug) VALUES (${'historic-version'},${historic.id},${1},${{ heading: { key: 'entry.private' } }},${''})`
    await expect(updateDataRowTable(harness!.db, MAIN_SCOPE, historic.id, table.id, null, 'plugin-example')).rejects.toBeInstanceOf(LocalizedDataReferenceAccessError)
  })

  it('rejects unauthorized localized draft overrides before the render-only preview can disclose catalogue text', async () => {
    const { table } = await setup()
    const persona = await dataPersona()
    await harness!.db`UPDATE data_tables SET kind = ${'postType'} WHERE id = ${table.id}`
    await write(table, { heading: { key: 'entry.a' } }, null, 'owned')
    await harness!.db`UPDATE data_rows SET author_user_id = ${persona.user.id} WHERE id = ${'owned'}`
    const endpoint = '/admin/api/cms/data/rows/owned/preview'
    const known = await harness!.cms(endpoint, { method: 'POST', cookie: persona.cookie, json: { cells: { heading: { key: 'entry.private' } } } })
    const unknown = await harness!.cms(endpoint, { method: 'POST', cookie: persona.cookie, json: { cells: { heading: { key: 'entry.absent' } } } })
    expect(known.status).toBe(403)
    expect(unknown.status).toBe(403)
    expect(await known.json()).toEqual(await unknown.json())
    expect((await getDataRow(harness!.db, MAIN_SCOPE, 'owned'))!.cells.heading).toEqual({ key: 'entry.a' })
  })

  it('validates the final merge schema against retained rows atomically and restores combined schema/row changes on undo', async () => {
    const { table, ownerCookie, ownerId } = await setup()
    await harness!.db`UPDATE data_tables SET fields_json = ${[{ ...title, type: 'text' }]} WHERE id = ${table.id}`
    const ordinary = (await getDataTable(harness!.db, MAIN_SCOPE, table.id))!
    await write(ordinary, { heading: 'Original title' }, ownerId, 'shared')
    const fork = await harness!.cms('/admin/api/cms/branches', { method: 'POST', cookie: ownerCookie, json: { name: 'Localized schema' } })
    expect(fork.status).toBe(201)
    const { branch } = await readJson<{ branch: { id: string } }>(fork)
    const scope = { branchId: branch.id }
    const { physicalId } = await import('@core/branches')
    await harness!.db`UPDATE data_tables SET fields_json = ${[title]} WHERE id = ${physicalId(branch.id, table.id)}`
    await saveDataRowDraft(harness!.db, scope, 'shared', { cells: { heading: { key: 'entry.a' } }, slug: '' }, ownerId)
    await write(ordinary, { heading: 'Retained literal' }, ownerId, 'retained')
    const before = await harness!.db.unsafe('SELECT id, fields_json FROM data_tables ORDER BY id')
    await expect(applyBranchMerge(harness!.db, { branchId: branch.id, direction: 'merge', resolutions: {}, actorUserId: ownerId })).rejects.toBeInstanceOf(LocalizationError)
    expect(await harness!.db.unsafe('SELECT id, fields_json FROM data_tables ORDER BY id')).toEqual(before)
    expect((await getDataRow(harness!.db, MAIN_SCOPE, 'shared'))!.cells.heading).toBe('Original title')
    await saveDataRowDraft(harness!.db, MAIN_SCOPE, 'retained', { cells: { heading: { key: 'entry.b' } }, slug: '' }, ownerId)
    await applyBranchMerge(harness!.db, { branchId: branch.id, direction: 'merge', resolutions: {}, actorUserId: ownerId })
    expect((await getDataTable(harness!.db, MAIN_SCOPE, table.id))!.fields[0].type).toBe('localizedText')
    await undoBranchMerge(harness!.db, { branchId: branch.id, direction: 'merge', actorUserId: ownerId })
    expect((await getDataTable(harness!.db, MAIN_SCOPE, table.id))!.fields[0].type).toBe('text')
    expect((await getDataRow(harness!.db, MAIN_SCOPE, 'shared'))!.cells.heading).toBe('Original title')
  })
})

describe('native localized data loop query', () => {
  it('preserves numeric ordering and empty numeric cells last in either direction after localized projection', async () => {
    const { table, ownerId } = await setup()
    const fields = [title, { id: 'score', label: 'Score', type: 'number' as const }]
    await harness!.db`UPDATE data_tables SET fields_json = ${fields} WHERE id = ${table.id}`
    for (const [id, score] of [['n2', 2], ['n10', 10], ['missing', null], ['broken', 'invalid']] as const) {
      await write(table, { heading: { key: 'entry.a' }, score }, ownerId, id)
    }
    const input = { tableId: table.id, orderBy: 'cell:score', limit: 10, offset: 0,
      localization: { language: 'de', translations: messages.de } }
    expect((await fetchPublishedDataRowItems(harness!.db, { ...input, direction: 'asc' })).items.map(item => item.id)).toEqual(['n2', 'n10', 'broken', 'missing'])
    expect((await fetchPublishedDataRowItems(harness!.db, { ...input, direction: 'desc' })).items.map(item => item.id)).toEqual(['n10', 'n2', 'broken', 'missing'])
  })

  it('projects, filters, orders, counts and slices the same stored rows in the selected language', async () => {
    const { table, ownerId } = await setup()
    await write(table, { heading: { key: 'entry.a' }, ordinary: '{site.translations.entry.a}' }, ownerId, 'a')
    await write(table, { heading: { key: 'entry.b' } }, ownerId, 'b')
    const input = { tableId: table.id, orderBy: 'cell:heading', direction: 'asc' as const, limit: 1, offset: 0 }
    const it = await fetchPublishedDataRowItems(harness!.db, { ...input, localization: { language: 'it', translations: messages.it } })
    const de = await fetchPublishedDataRowItems(harness!.db, { ...input, localization: { language: 'de', translations: messages.de } })
    expect(it.items.map(item => item.id)).toEqual(['b'])
    expect(de.items.map(item => item.id)).toEqual(['a'])
    expect(it.totalItems).toBe(2)
    expect(de.items[0].fields.ordinary).toBe('{site.translations.entry.a}')
    const filtered = await fetchPublishedDataRowItems(harness!.db, { ...input, localization: { language: 'de', translations: messages.de }, cellFilter: { field: 'heading', operator: 'is', value: 'Zebra Deutsch' } })
    expect(filtered.items.map(item => item.id)).toEqual(['b'])
    expect(filtered.totalItems).toBe(1)
    const visible = await fetchPublishedDataRowItems(harness!.db, { ...input, localization: { language: 'de', translations: messages.de }, readableRowIds: new Set(['b']) })
    expect(visible.totalItems).toBe(1)
    expect(visible.items[0].id).toBe('b')
    await expect(fetchPublishedDataRowItems(harness!.db, input)).rejects.toBeInstanceOf(LocalizationError)
    expect((await getDataRow(harness!.db, MAIN_SCOPE, 'a'))!.cells.heading).toEqual({ key: 'entry.a' })
  })

  it('rejects a missing reference before a new publication generation replaces the active snapshot', async () => {
    const { table, site, ownerId, ownerCookie } = await setup()
    await write(table, { heading: { key: 'entry.a' } }, ownerId, 'a')
    const page = site.pages[0]
    const loop = createNode('base.loop')
    loop.props = { sourceId: 'data.rows', filters: { tableId: table.id }, limit: 10 }
    const text = createNode('base.text')
    text.props = { text: '' }
    text.dynamicBindings = { text: { source: 'currentEntry', field: 'heading' } }
    loop.children = [text.id]
    page.nodes[loop.id] = loop
    page.nodes[text.id] = text
    page.nodes[page.rootNodeId].children.push(loop.id)
    await saveDataRowDraft(harness!.db, MAIN_SCOPE, page.id, { cells: pageToCells(page), slug: page.slug })
    await publishDraftSite(harness!.db, ownerId)
    const before = await harness!.db.unsafe('SELECT * FROM site_snapshots ORDER BY id')
    const beforeVersion = getPublishVersion()
    await harness!.db`UPDATE data_rows SET cells_json = ${{ heading: { key: 'entry.missing' } }} WHERE id = ${'a'}`
    const response = await harness!.cms('/admin/api/cms/publish', { method: 'POST', cookie: ownerCookie })
    expect(response.status).toBe(422)
    expect(await harness!.db.unsafe('SELECT * FROM site_snapshots ORDER BY id')).toEqual(before)
    expect(getPublishVersion()).toBe(beforeVersion)
  }, 15_000)
})
