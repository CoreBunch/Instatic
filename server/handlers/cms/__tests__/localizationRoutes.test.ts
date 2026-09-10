import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRowSchema } from '@core/data/schemas'
import { publishDataRow } from '../../../publish/publishRow'
import { listDataRowsWithFilter } from '../../../repositories/data/rows/filter'
import { pageToCells } from '@core/data/pageFromRow'
import { makePage } from '../../../../src/__tests__/publisher/helpers'
import { getDraftSite, saveDraftSite } from '../../../repositories/site'
import { publishDraftSite } from '../../../publish/publishSite'
import { readArtefact } from '../../../publish/staticArtefact'
import { arePublishedArtefactsCurrent } from '../../../publish/publishState'
import { Type, parseValue } from '@core/utils/typeboxHelpers'
import { LocaleSchema, PublicationOverviewSchema } from '@core/localization-schema'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../../src/__tests__/helpers/capabilityHarness'
import { createDataRow, getDataRow, saveDataRowDraft } from '../../../repositories/data'
import { getContentLocalization, listContentLocalizations, saveContentLocalizationDraft } from '../../../repositories/localization'

let uploadsDir: string
let harness: CapabilityTestHarness
let owner: string
let architect: string
let reader: string
let editor: string
let rowId: string
let localeId: string
const prefix = '/admin/api/cms'
const LocaleEnvelope = Type.Object({ locale: LocaleSchema })
beforeAll(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), 'locale-http-'))
  harness = await createCapabilityTestHarness({ uploadsDir })
  owner = await harness.setupOwner()
  architect = (await harness.createRoleUser({ name: 'Language architect', slug: 'language-architect', capabilities: ['site.read', 'site.structure.edit'] })).cookie
  reader = (await harness.createRoleUser({ name: 'Language reader', slug: 'language-reader', capabilities: ['site.read'] })).cookie
  editor = (await harness.createRoleUser({ name: 'Language editor', slug: 'language-editor', capabilities: ['site.read', 'site.content.edit'] })).cookie
  rowId = (await createDataRow(harness.db, { tableId: 'pages', slug: 'locale-test', cells: { title: 'Source', slug: 'locale-test', body: { rootNodeId: 'root', nodes: { root: { id: 'root', moduleId: 'base.container', children: [], props: {}, classIds: [], breakpointOverrides: {} } } } } })).id
}, 15_000)
afterAll(async () => { await harness?.cleanup(); await rm(uploadsDir, { recursive: true, force: true }) })

describe('CMS language HTTP boundaries', () => {
  it('requires authentication for discovery and structural permission for creation', async () => {
    expect((await harness.cms(`${prefix}/locales`)).status).toBe(401)
    expect((await harness.cms(`${prefix}/locales`, { cookie: reader })).status).toBe(200)
    const input = { code: 'de', name: 'Deutsch', pathPrefix: 'de', direction: 'ltr', enabled: true }
    expect((await harness.cms(`${prefix}/locales`, { method: 'POST', cookie: reader, json: input })).status).toBe(403)
    const response = await harness.cms(`${prefix}/locales`, { method: 'POST', cookie: architect, json: input })
    expect(response.status).toBe(201)
    const { locale } = parseValue(LocaleEnvelope, await response.json())
    localeId = locale.id
    expect(locale.enabled).toBe(false)
    expect(await listContentLocalizations(harness.db, { localeId })).toEqual([])
  })

  it('separates language configuration from permission to expose that language', async () => {
    expect((await harness.cms(`${prefix}/locales/${localeId}`, { method: 'PATCH', cookie: architect, json: { enabled: true } })).status).toBe(403)
    expect((await harness.cms(`${prefix}/locales/${localeId}`, { method: 'PATCH', cookie: architect, json: { name: 'Deutsch neu' } })).status).toBe(200)
    const enabled = await harness.cms(`${prefix}/locales/${localeId}`, { method: 'PATCH', cookie: owner, json: { enabled: true } })
    expect(enabled.status).toBe(200)
    expect(parseValue(LocaleEnvelope, await enabled.json()).locale.enabled).toBe(true)
    expect((await getDataRow(harness.db, rowId, localeId))?.localization).toBeNull()
  })

  it('rejects unknown and empty languages without default-language writes', async () => {
    expect((await harness.cms(`${prefix}/locales/missing`, { method: 'PATCH', cookie: owner, json: { name: 'Missing' } })).status).toBe(404)
    expect((await harness.cms(`${prefix}/data/rows/${rowId}/localizations?localeId=missing`, { cookie: reader })).status).toBe(404)
    expect((await harness.cms(`${prefix}/data/rows/${rowId}/localizations?localeId=`, { cookie: reader })).status).toBe(400)
    const review = await harness.cms(`${prefix}/data/rows/${rowId}/translation?localeId=missing`, { method: 'POST', cookie: editor, json: { action: 'review', fieldId: 'title' } })
    expect(review.status).toBe(404)
    expect((await getDataRow(harness.db, rowId))?.cells.title).toBe('Source')
  })

  it('requires localized editing permission and rejects node-scoped review without changing metadata', async () => {
    await saveContentLocalizationDraft(harness.db, rowId, localeId, { cells: { title: 'Übersetzt', body: { nodes: { root: { hidden: true } } } }, slug: 'locale-test' })
    const path = `${prefix}/data/rows/${rowId}/translation?localeId=${localeId}`
    expect((await harness.cms(path, { method: 'POST', cookie: reader, json: { action: 'review', fieldId: 'title' } })).status).toBe(403)
    const rejected = await harness.cms(path, { method: 'POST', cookie: editor, json: { action: 'review', fieldId: 'body', nodeId: 'root', property: 'hidden' } })
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toContain('whole field')
    expect((await getContentLocalization(harness.db, rowId, localeId))?.translationMeta).toEqual({})
    expect((await harness.cms(path, { method: 'POST', cookie: editor, json: { action: 'review', fieldId: 'title' } })).status).toBe(200)
    expect((await getContentLocalization(harness.db, rowId, localeId))?.translationMeta.title?.reviewState).toBe('reviewed')
    expect((await harness.cms(path, { method: 'POST', cookie: editor, json: { action: 'reset', fieldId: 'title' } })).status).toBe(200)
    expect((await getDataRow(harness.db, rowId, localeId))?.cells.title).toBe('Source')
    const resetVisibility = await harness.cms(path, { method: 'POST', cookie: editor, json: { action: 'reset', fieldId: 'body', nodeId: 'root', property: 'hidden' } })
    expect(resetVisibility.status).toBe(200)
    expect(Object.hasOwn((await getContentLocalization(harness.db, rowId, localeId))!.cells, 'body')).toBe(false)
  })
  it('rebakes all live dependencies when a whole language is disabled and re-enabled', async () => {
    const shell = await getDraftSite(harness.db)
    await saveDraftSite(harness.db, { ...shell!, settings: { ...shell!.settings, publicOrigin: 'https://website.test' } })
    const page = { ...makePage({ root: { moduleId: 'base.container', children: ['copy', 'switcher'] },
      copy: { moduleId: 'base.text', props: { text: 'Frozen source', tag: 'p', htmlAttributes: {} } },
      switcher: { moduleId: 'base.language-switcher', props: {} },
    }), id: rowId, slug: 'locale-test', title: 'Source' }
    await saveDataRowDraft(harness.db, rowId, { cells: pageToCells(page), slug: page.slug })
    await saveContentLocalizationDraft(harness.db, rowId, localeId, { cells: { title: 'Deutsch', body: { nodes: { copy: { props: { text: 'Frozen German' } } } } }, slug: 'sprachtest' })
    await publishDraftSite(harness.db, null, uploadsDir, { variants: [{ rowId, localeId: 'default' }, { rowId, localeId }] })
    expect(await readArtefact(uploadsDir, '/locale-test')).toContain('hreflang="de"')
    const source = await getDataRow(harness.db, rowId)
    await saveDataRowDraft(harness.db, rowId, { cells: { ...source!.cells, title: 'Unpublished title' }, slug: page.slug })
    const previousVersion = (await getContentLocalization(harness.db, rowId, localeId))!.activeVersionId
    expect((await harness.cms(`${prefix}/locales/${localeId}`, { method: 'PATCH', cookie: owner, json: { enabled: false } })).status).toBe(200)
    expect(arePublishedArtefactsCurrent()).toBe(true)
    const hidden = await readArtefact(uploadsDir, '/locale-test')
    expect(hidden).not.toContain('hreflang="de"')
    expect(hidden).not.toContain('/de/sprachtest')
    expect(hidden).not.toContain('Unpublished title')
    expect(hidden).toContain('Frozen source')
    expect(await readArtefact(uploadsDir, '/de/sprachtest')).toBeNull()
    expect((await getContentLocalization(harness.db, rowId, localeId))!.activeVersionId).toBe(previousVersion)
    expect((await harness.cms(`${prefix}/locales/${localeId}`, { method: 'PATCH', cookie: owner, json: { enabled: true } })).status).toBe(200)
    expect(arePublishedArtefactsCurrent()).toBe(true)
    expect(await readArtefact(uploadsDir, '/locale-test')).toContain('hreflang="de"')
    expect(await readArtefact(uploadsDir, '/de/sprachtest')).toContain('Frozen German')
  })

  it('includes independently selectable templates in the publication overview without a public URL', async () => {
    const template = { ...makePage({ root: { moduleId: 'base.text', props: { text: 'Template' } } }),
      id: 'overview-template', slug: 'overview-template', template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 } }
    await createDataRow(harness.db, { id: template.id, tableId: 'pages', slug: template.slug, cells: pageToCells(template) })
    const response = await harness.cms(`${prefix}/publish/selection`, { cookie: owner })
    expect(response.status).toBe(200)
    const overview = parseValue(PublicationOverviewSchema, await response.json())
    const templates = overview.variants.filter((variant) => variant.rowId === template.id)
    expect(templates).toHaveLength(overview.locales.length)
    expect(templates.every((variant) => variant.isTemplate && variant.publicPath === null)).toBe(true)
    expect(overview.variants.find((variant) => variant.rowId === rowId)?.isTemplate).toBe(false)
  })

  it('uses the same translated slug in HTTP controls, filters and the frozen public route', async () => {
    const previous = (await getContentLocalization(harness.db, rowId, localeId))!
    await saveContentLocalizationDraft(harness.db, rowId, localeId, { cells: previous.cells, slug: 'canonical-draft' })
    const response = await harness.cms(`${prefix}/data/rows/${rowId}?localeId=${localeId}`, { cookie: owner })
    expect(response.status).toBe(200)
    const loaded = parseValue(Type.Object({ row: DataRowSchema }), await response.json()).row
    expect(loaded.slug).toBe('canonical-draft')
    expect(loaded.cells.slug).toBe('canonical-draft')
    const patched = await harness.cms(`${prefix}/data/rows/${rowId}?localeId=${localeId}`, { cookie: owner, method: 'PATCH', json: { cells: { ...loaded.cells, slug: 'edited-route' } } })
    expect(patched.status).toBe(200)
    const saved = parseValue(Type.Object({ row: DataRowSchema }), await patched.json()).row
    expect(saved.slug).toBe('edited-route')
    expect(saved.cells.slug).toBe('edited-route')
    expect((await listDataRowsWithFilter(harness.db, 'pages', { localeId, filter: { slug: 'edited-route' } })).rows.map((row) => row.id)).toEqual([rowId])
    const published = await publishDataRow(harness.db, rowId, null, uploadsDir, { localeId })
    expect(published.version.slug).toBe('edited-route')
    expect(published.version.publicPath).toBe('/de/edited-route')
  })

})
