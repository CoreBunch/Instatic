/**
 * A plugin may create pages (when granted write access to the `pages` table),
 * but how a page is indexed is a structural setting: `cms.content.entries.create`
 * and `createMany` drop the `seo` cell.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import type { DbClient } from '../../../db/client'
import { getDataRowBySlug } from '../../../repositories/data'
import { MAIN_SCOPE } from '../../../branches/scope'
import { parsePluginManifest } from '@core/plugins/manifest'
import { hookBus } from '@core/plugins/hookBus'
import { applyContentEntryCellsFilter } from '../../../publish/contentEvents'
import { hostPlugins } from '../registry'
import type { HostPluginRecord } from '../types'
import { PluginRateLimitStore } from '../pluginRateLimit'
import { handleContentEntriesCreate, handleContentEntriesCreateMany } from './content'

const PLUGIN = 'acme.pages'
const SEO = { description: 'From a plugin', robots: 'noindex' }

function pluginRecord(): HostPluginRecord {
  const manifest = parsePluginManifest({
    id: PLUGIN,
    name: 'Pages fixture',
    version: '1.0.0',
    apiVersion: 1,
    description: 'writes pages',
    permissions: ['cms.content.read', 'cms.content.write'],
    contentAccess: [{ table: 'pages', modes: ['read', 'write'] }],
  })
  return {
    manifest: { ...manifest, grantedPermissions: manifest.permissions },
    routes: new Map(),
    hookListeners: [],
    hookFilters: [],
    memberExportFilterId: null,
    loopSources: [],
    mediaAdapters: [],
    mediaUrlTransformers: [],
    inflightFetches: new Map(),
    rateLimits: new PluginRateLimitStore(10),
  }
}

let db: DbClient

beforeEach(async () => {
  db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
})

const storedSeo = async (slug: string) => (await getDataRowBySlug(db, MAIN_SCOPE, 'pages', slug))?.cells.seo

describe('plugin page creation', () => {
  it('entries.create drops the head settings', async () => {
    await handleContentEntriesCreate(
      { kind: 'api-call', correlationId: 'c1', pluginId: PLUGIN, target: 'cms.content.entries.create', args: ['pages', { slug: 'made', cells: { title: 'Made', slug: 'made', seo: SEO } }] },
      pluginRecord(),
      db,
    )
    expect(await getDataRowBySlug(db, MAIN_SCOPE, 'pages', 'made')).not.toBeNull()
    expect(await storedSeo('made')).toBeUndefined()
  })

  it('entries.createMany drops the head settings', async () => {
    await handleContentEntriesCreateMany(
      { kind: 'api-call', correlationId: 'c2', pluginId: PLUGIN, target: 'cms.content.entries.createMany', args: ['pages', [{ slug: 'one', cells: { title: 'One', slug: 'one', seo: SEO } }]] },
      pluginRecord(),
      db,
    )
    expect(await getDataRowBySlug(db, MAIN_SCOPE, 'pages', 'one')).not.toBeNull()
    expect(await storedSeo('one')).toBeUndefined()
  })
})

it('keeps the page structure supplied by the owner when a content filter returns replacement cells', async () => {
  hostPlugins.set(PLUGIN, pluginRecord())
  hookBus.filter(PLUGIN, 'content.entry.cells', () => ({ title: 'Edited title' }))
  try {
    const cells = { title: 'Original title', seo: SEO, access: { level: 'members', onDeny: 'hide' } }
    const filtered = await applyContentEntryCellsFilter(cells, {
      scope: MAIN_SCOPE,
      table: { id: 'pages', slug: 'pages', createdByPluginId: null },
      entryId: 'new',
      actor: { kind: 'user', userId: 'owner' },
    })
    expect(filtered).toEqual({ ...cells, title: 'Edited title' })
  } finally {
    hookBus.unregisterPlugin(PLUGIN)
    hostPlugins.delete(PLUGIN)
  }
})
