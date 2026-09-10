/**
 * End-to-end host-side coverage for the `@own-created` content-access flow:
 * a plugin creates a table through `cms.content.tables.create` (which records
 * `created_by_plugin_id`), then reaches its entries through the ordinary
 * `cms.content.entries.*` handlers via the `@own-created` marker — while
 * every other plugin stays locked out of that table.
 *
 * Handlers reply through `replyApiOk`, which silently drops when no worker
 * is registered for the plugin id — so success is asserted via repository
 * reads and denial via the thrown access error (exactly what the dispatcher
 * turns into an error reply in production).
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import type { DbClient } from '../../../db/client'
import { getDataTableBySlug, getDataRowBySlug } from '../../../repositories/data'
import type { DataTable } from '@core/data/schemas'
import { parsePluginManifest } from '@core/plugins/manifest'
import { OWN_CREATED_TABLES_MARKER, type ContentAccessEntry } from '@core/plugin-sdk'
import { assertContentTableAccess } from '../registry'
import type { HostPluginRecord } from '../types'
import {
  handleContentEntriesCreate,
  handleContentEntriesList,
  handleContentTablesCreate,
  handleContentTablesGet,
} from './content'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  return db
}

function pluginRecord(id: string, contentAccess: ContentAccessEntry[]): HostPluginRecord {
  const manifest = parsePluginManifest({
    id,
    name: 'Importer fixture',
    version: '1.0.0',
    apiVersion: 1,
    description: 'own-created table access fixture',
    permissions: ['cms.content.read', 'cms.content.write', 'cms.content.tables.manage'],
    contentAccess,
  })
  return {
    manifest,
    routes: new Map(),
    hookListeners: [],
    hookFilters: [],
    loopSources: [],
    mediaAdapters: [],
    mediaUrlTransformers: [],
    inflightFetches: new Map(),
  }
}

const IMPORTER = 'acme.importer'

async function mustGetTable(db: DbClient, slug: string): Promise<DataTable> {
  const table = await getDataTableBySlug(db, slug)
  if (!table) throw new Error(`fixture table "${slug}" missing`)
  return table
}

/** Create `imported-products` as the importer plugin via the real handler. */
async function createImportedProductsTable(db: DbClient, entry: HostPluginRecord): Promise<void> {
  await handleContentTablesCreate(
    {
      kind: 'api-call',
      correlationId: 'c-create-table',
      pluginId: IMPORTER,
      target: 'cms.content.tables.create',
      args: [{
        slug: 'imported-products',
        name: 'Imported Products',
        singularLabel: 'Imported product',
        pluralLabel: 'Imported products',
        fields: [
          { id: 'title', label: 'Title', type: 'text', required: true },
          { id: 'slug', label: 'Slug', type: 'text', required: false },
        ],
      }],
    },
    entry,
    db,
  )
}

describe('cms.content.tables.create → @own-created access', () => {
  let db: DbClient
  const importer = pluginRecord(IMPORTER, [
    { table: OWN_CREATED_TABLES_MARKER, modes: ['read', 'write'] },
  ])

  beforeEach(async () => {
    db = await freshDb()
    await createImportedProductsTable(db, importer)
  })

  it('records the creating plugin on the table row', async () => {
    const created = await mustGetTable(db, 'imported-products')
    expect(created.createdByPluginId).toBe(IMPORTER)
    expect(created.system).toBe(false)
  })

  it('lets the creator write and read entries via the marker', async () => {
    await handleContentEntriesCreate(
      {
        kind: 'api-call',
        correlationId: 'c-create-entry',
        pluginId: IMPORTER,
        target: 'cms.content.entries.create',
        args: ['imported-products', { slug: 'widget-1', cells: { title: 'Widget', slug: 'widget-1' } }],
      },
      importer,
      db,
    )
    const table = await mustGetTable(db, 'imported-products')
    const row = await getDataRowBySlug(db, table.id, 'widget-1')
    expect(row?.cells.title).toBe('Widget')

    // Reads ride the same marker — the list handler resolves + asserts.
    await expect(handleContentEntriesList(
      {
        kind: 'api-call',
        correlationId: 'c-list',
        pluginId: IMPORTER,
        target: 'cms.content.entries.list',
        args: ['imported-products', {}],
      },
      importer,
      db,
    )).resolves.toBeUndefined()

    await expect(handleContentTablesGet(
      {
        kind: 'api-call',
        correlationId: 'c-get-table',
        pluginId: IMPORTER,
        target: 'cms.content.tables.get',
        args: ['imported-products'],
      },
      importer,
      db,
    )).resolves.toBeUndefined()
  })

  it('denies a different plugin carrying the same marker', async () => {
    const other = pluginRecord('rival.importer', [
      { table: OWN_CREATED_TABLES_MARKER, modes: ['read', 'write'] },
    ])
    await expect(handleContentEntriesCreate(
      {
        kind: 'api-call',
        correlationId: 'c-rival',
        pluginId: 'rival.importer',
        target: 'cms.content.entries.create',
        args: ['imported-products', { cells: { title: 'Hijack' } }],
      },
      other,
      db,
    )).rejects.toThrow('does not have contentAccess declared for table "imported-products"')
  })

  it('denies a plugin without the marker even for tables it could name', async () => {
    // Declares the slug of ANOTHER plugin's created table statically — the
    // slug entry matches, so this is allowed: static declarations are the
    // operator-reviewed path for cross-plugin table access.
    const staticDeclarer = pluginRecord('acme.reader', [
      { table: 'imported-products', modes: ['read'] },
    ])
    await expect(handleContentEntriesList(
      {
        kind: 'api-call',
        correlationId: 'c-static-read',
        pluginId: 'acme.reader',
        target: 'cms.content.entries.list',
        args: ['imported-products', {}],
      },
      staticDeclarer,
      db,
    )).resolves.toBeUndefined()

    // But its declared modes still bind: write was not declared.
    await expect(handleContentEntriesCreate(
      {
        kind: 'api-call',
        correlationId: 'c-static-write',
        pluginId: 'acme.reader',
        target: 'cms.content.entries.create',
        args: ['imported-products', { cells: { title: 'Nope' } }],
      },
      staticDeclarer,
      db,
    )).rejects.toThrow('not for mode "write"')
  })

  it('still denies the creator a mode its marker entry does not declare', async () => {
    // The importer declared read+write only — delete-capable handlers assert
    // mode 'delete' and must fail even for own-created tables.
    const table = await mustGetTable(db, 'imported-products')
    expect(() => assertContentTableAccess(importer, table, 'delete'))
      .toThrow('not for mode "delete"')
  })
})
