import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { parsePluginManifest } from '@core/plugins/manifest'
import { hookBus } from '@core/plugins/hookBus'
import { parseValue } from '@core/utils/typeboxHelpers'
import { ContentEntrySchema } from '@core/plugin-sdk/contentSchemas'
import { createSqliteClient } from '../../../db/sqlite'
import { runMigrations } from '../../../db/runMigrations'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { createDataRow, getDataRow } from '../../../repositories/data'
import { createLocale, saveContentLocalizationDraft, setContentLocalizationPublishedVersion } from '../../../repositories/localization'
import { createPluginVm } from '../../quickjs/vm'
import { parseApiCall } from '../../protocol/parser'
import { dispatchApiCall } from '../apiDispatch'
import { hostPlugins, setPluginWorkerDbClient } from '../registry'
import * as replies from '../apiReplies'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const db = createSqliteClient(':memory:')
  cleanups.push(() => db.close())
  await runMigrations(db, sqliteMigrations)
  const locale = await createLocale(db, { code: 'de', name: 'Deutsch', pathPrefix: 'de', enabled: true, direction: 'ltr' })
  const row = await createDataRow(db, { id: 'post', tableId: 'posts', cells: { title: 'English', slug: 'english' }, slug: 'english' })
  await saveContentLocalizationDraft(db, row.id, locale.id, { cells: { title: 'Deutsch', slug: 'deutsch' }, slug: 'deutsch' })
  const pluginId = 'acme.locale-test'
  const manifest = parsePluginManifest({ id: pluginId, name: 'Locale test', version: '1.0.0', apiVersion: 1,
    permissions: ['cms.content.read', 'cms.content.write', 'cms.content.publish'],
    grantedPermissions: ['cms.content.read', 'cms.content.write', 'cms.content.publish'],
    contentAccess: [{ table: 'posts', modes: ['read', 'write', 'publish'] }], resources: [], adminPages: [],
  })
  hostPlugins.set(pluginId, { manifest, assetRootPath: '/tmp', routes: new Map(), hookListeners: [], hookFilters: [], loopSources: [], mediaAdapters: [], mediaUrlTransformers: [], inflightFetches: new Map() })
  setPluginWorkerDbClient(db)
  cleanups.push(() => { hostPlugins.delete(pluginId); hookBus.unregisterPlugin(pluginId) })
  const successes: unknown[] = []
  const errors: string[] = []
  const success = spyOn(replies, 'replyApiOk').mockImplementation((_plugin, _correlation, value) => { successes.push(value) })
  const error = spyOn(replies, 'replyApiError').mockImplementation((_plugin, _correlation, message) => { errors.push(message) })
  cleanups.push(() => { success.mockRestore(); error.mockRestore() })
  async function call(target: string, args: unknown[]) {
    await dispatchApiCall(parseApiCall({ kind: 'api-call', correlationId: 'test', pluginId, target, args }))
    if (errors.length) throw new Error(errors.pop())
    return successes.pop()
  }
  return { db, locale, row, pluginId, call }
}

describe('localized plugin content', () => {
  it('updates only the requested language and attributes filter/event scopes', async () => {
    const { db, locale, row, pluginId, call } = await fixture()
    const events: unknown[] = []
    const scopes: unknown[] = []
    hookBus.on(pluginId, 'content.entry.updated', (payload) => { events.push(payload) })
    hookBus.filter(pluginId, 'content.entry.cells', (cells, context) => { scopes.push(context); return cells })
    const updated = parseValue(ContentEntrySchema, await call('cms.content.entries.update', ['posts', row.id, { localeId: locale.id, cells: { title: 'Geändert' } }]))
    expect(updated.localeId).toBe(locale.id)
    expect(updated.cells.title).toBe('Geändert')
    expect((await getDataRow(db, row.id))?.cells.title).toBe('English')
    expect(events[0]).toMatchObject({ localeId: locale.id, entryId: row.id })
    expect(scopes[0]).toMatchObject({ localeId: locale.id })
    const found = parseValue(ContentEntrySchema, await call('cms.content.entries.getBySlug', ['posts', 'deutsch', { localeId: locale.id }]))
    expect(found.id).toBe(row.id)
    expect(await call('cms.content.entries.getBySlug', ['posts', 'deutsch', {}])).toBeNull()
  })

  it('unpublishes one locale, retains source publication, and never falls back from a missing public variant', async () => {
    const { db, locale, row, call } = await fixture()
    for (const [id, localeId, number] of [['en-version', 'default', 1], ['de-version', locale.id, 2]] as const) {
      await db`insert into data_row_versions (id, row_id, locale_id, version_number, cells_json, slug) values (${id}, ${row.id}, ${localeId}, ${number}, ${{ title: 'Frozen' }}, 'live')`
      await setContentLocalizationPublishedVersion(db, row.id, localeId, id)
    }
    const offline = parseValue(ContentEntrySchema, await call('cms.content.entries.unpublish', ['posts', row.id, { localeId: locale.id }]))
    expect(offline.status).toBe('unpublished')
    expect((await getDataRow(db, row.id))?.status).toBe('published')
    expect(await call('cms.content.snapshot', [row.id, { localeId: locale.id }])).toBeNull()
    expect(await call('cms.content.snapshot', [row.id, {}])).toMatchObject({ localeId: 'default', cells: { title: 'Frozen' } })
  })

  it('applies language and table permissions before search pagination', async () => {
    const { db, locale, call } = await fixture()
    await createDataRow(db, { id: 'private-page', tableId: 'pages', cells: { title: 'Private', slug: 'deutsch-private' }, slug: 'deutsch-private' })
    const result = await call('cms.content.search', ['deutsch', { localeId: locale.id, limit: 1 }])
    expect(result).toEqual([expect.objectContaining({ id: 'post', localeId: locale.id, slug: 'deutsch' })])
  })

  it('forwards locale options through the regenerated QuickJS bootstrap and gates unpublish by granted permission', async () => {
    const calls: { target: string; args: unknown[] }[] = []
    const vm = await createPluginVm({
      pluginSource: 'globalThis.__plugin_exports = { activate: async function(api) { await api.cms.content.locales.list(); await api.cms.content.table("posts").get("post", {localeId:"de"}); await api.cms.content.search("test", {localeId:"de",limit:3}); await api.cms.content.tree("page","body",{localeId:"de"}).read(); await api.cms.content.table("posts").unpublish("post",{localeId:"de"}); } };',
      env: { pluginId: 'acme.vm-locales', manifestVersion: '1.0.0', grantedPermissions: ['cms.content.read'], assetBasePath: '/uploads/plugins/acme.vm-locales/1.0.0', settings: {},
        hostCall: async (target, args) => { parseApiCall({ kind: 'api-call', pluginId: 'acme.vm-locales', correlationId: 'test', target, args }); calls.push({ target, args }); return null }, log: () => {}, },
    })
    try {
      await expect(vm.runLifecycle('activate')).rejects.toThrow('cms.content.publish')
      expect(calls).toEqual([
        { target: 'cms.content.locales.list', args: [] },
        { target: 'cms.content.entries.get', args: ['posts', 'post', { localeId: 'de' }] },
        { target: 'cms.content.search', args: ['test', { localeId: 'de', limit: 3 }] },
        { target: 'cms.content.tree.read', args: ['page', 'body', { localeId: 'de' }] },
      ])
    } finally { vm.dispose() }
  })
})
