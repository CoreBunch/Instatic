/**
 * `assertContentTableAccess` / `hasContentTableAccess` — the per-table
 * authorization matrix for the `api.cms.content.*` surface.
 *
 * Locked here:
 *   - slug entries match by exact slug and enforce per-mode narrowing;
 *   - the `@own-created` marker matches ONLY tables whose `createdByPluginId`
 *     is the calling plugin (never by slug, never another plugin's tables,
 *     never user-created tables);
 *   - entries combine as a union — any matching entry declaring the mode
 *     allows the operation.
 *
 * Manifests are built through `parsePluginManifest` so the tests also cover
 * the parser accepting the marker as a `contentAccess[].table` value.
 */
import { describe, expect, it } from 'bun:test'
import { parsePluginManifest } from '@core/plugins/manifest'
import { OWN_CREATED_TABLES_MARKER } from '@core/plugin-sdk'
import type { ContentAccessEntry } from '@core/plugin-sdk'
import type { DataTable } from '@core/data/schemas'
import { assertContentTableAccess, hasContentTableAccess } from './registry'
import type { HostPluginRecord } from './types'

function pluginRecord(id: string, contentAccess: ContentAccessEntry[]): HostPluginRecord {
  const manifest = parsePluginManifest({
    id,
    name: 'Test plugin',
    version: '1.0.0',
    apiVersion: 1,
    description: 'contentAccess matrix fixture',
    permissions: ['cms.content.read', 'cms.content.write', 'cms.content.publish', 'cms.content.delete'],
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

function table(slug: string, createdByPluginId: string | null): DataTable {
  return {
    id: `tbl_${slug}`,
    name: slug,
    slug,
    kind: 'data',
    singularLabel: slug,
    pluralLabel: slug,
    routeBase: `/${slug}`,
    primaryFieldId: 'title',
    fields: [],
    system: false,
    createdByUserId: null,
    createdByPluginId,
    updatedByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('assertContentTableAccess — slug entries', () => {
  const entry = pluginRecord('acme.seo', [{ table: 'posts', modes: ['read', 'write'] }])

  it('allows a declared table + declared mode', () => {
    expect(() => assertContentTableAccess(entry, table('posts', null), 'read')).not.toThrow()
    expect(() => assertContentTableAccess(entry, table('posts', null), 'write')).not.toThrow()
  })

  it('rejects a declared table with an undeclared mode', () => {
    expect(() => assertContentTableAccess(entry, table('posts', null), 'delete'))
      .toThrow('not for mode "delete"')
  })

  it('rejects an undeclared table', () => {
    expect(() => assertContentTableAccess(entry, table('customers', null), 'read'))
      .toThrow('does not have contentAccess declared for table "customers"')
  })
})

describe('assertContentTableAccess — @own-created marker', () => {
  const importer = pluginRecord('acme.importer', [
    { table: OWN_CREATED_TABLES_MARKER, modes: ['read', 'write'] },
  ])

  it('allows tables created by this plugin, honoring the declared modes', () => {
    const own = table('runtime-products', 'acme.importer')
    expect(() => assertContentTableAccess(importer, own, 'read')).not.toThrow()
    expect(() => assertContentTableAccess(importer, own, 'write')).not.toThrow()
    expect(() => assertContentTableAccess(importer, own, 'delete'))
      .toThrow('not for mode "delete"')
  })

  it('rejects tables created by a different plugin', () => {
    expect(() => assertContentTableAccess(importer, table('runtime-products', 'other.importer'), 'read'))
      .toThrow('does not have contentAccess declared')
  })

  it('rejects user-created tables (null creator)', () => {
    expect(() => assertContentTableAccess(importer, table('customers', null), 'read'))
      .toThrow('does not have contentAccess declared')
  })

  it('never matches by slug — a table literally slugged like the marker stays inaccessible', () => {
    expect(() => assertContentTableAccess(importer, table(OWN_CREATED_TABLES_MARKER, null), 'read'))
      .toThrow('does not have contentAccess declared')
  })
})

describe('assertContentTableAccess — union of matching entries', () => {
  it('allows a mode declared by ANY matching entry', () => {
    // The slug entry narrows `forms` to read; the marker adds write for the
    // same (own-created) table. Union semantics: both modes are allowed.
    const entry = pluginRecord('acme.forms', [
      { table: 'forms', modes: ['read'] },
      { table: OWN_CREATED_TABLES_MARKER, modes: ['write'] },
    ])
    const ownForms = table('forms', 'acme.forms')
    expect(() => assertContentTableAccess(entry, ownForms, 'read')).not.toThrow()
    expect(() => assertContentTableAccess(entry, ownForms, 'write')).not.toThrow()
    expect(() => assertContentTableAccess(entry, ownForms, 'publish'))
      .toThrow('not for mode "publish"')
  })
})

describe('hasContentTableAccess — list/search membership', () => {
  it('covers declared slugs and own-created tables, nothing else', () => {
    const entry = pluginRecord('acme.importer', [
      { table: 'posts', modes: ['read'] },
      { table: OWN_CREATED_TABLES_MARKER, modes: ['read', 'write'] },
    ])
    expect(hasContentTableAccess(entry.manifest, table('posts', null))).toBe(true)
    expect(hasContentTableAccess(entry.manifest, table('runtime-products', 'acme.importer'))).toBe(true)
    expect(hasContentTableAccess(entry.manifest, table('runtime-products', 'other.plugin'))).toBe(false)
    expect(hasContentTableAccess(entry.manifest, table('customers', null))).toBe(false)
  })
})
