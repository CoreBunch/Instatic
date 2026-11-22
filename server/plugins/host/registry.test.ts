/**
 * `pluginHasContentTableAccess` — the per-table
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
import { pluginHasContentTableAccess } from './registry'
import type { HostPluginRecord } from './types'
import { PluginRateLimitStore } from './pluginRateLimit'

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

describe('content table access — slug entries', () => {
  const entry = pluginRecord('acme.seo', [{ table: 'posts', modes: ['read', 'write'] }])

  it('allows a declared table + declared mode', () => {
    expect(pluginHasContentTableAccess(entry, table('posts', null), ['read'])).toBe(true)
    expect(pluginHasContentTableAccess(entry, table('posts', null), ['write'])).toBe(true)
  })

  it('rejects a declared table with an undeclared mode', () => {
    expect(pluginHasContentTableAccess(entry, table('posts', null), ['delete'])).toBe(false)
  })

  it('rejects an undeclared table', () => {
    expect(pluginHasContentTableAccess(entry, table('customers', null), ['read'])).toBe(false)
  })
})

describe('content table access — @own-created marker', () => {
  const importer = pluginRecord('acme.importer', [
    { table: OWN_CREATED_TABLES_MARKER, modes: ['read', 'write'] },
  ])

  it('allows tables created by this plugin, honoring the declared modes', () => {
    const own = table('runtime-products', 'acme.importer')
    expect(pluginHasContentTableAccess(importer, own, ['read'])).toBe(true)
    expect(pluginHasContentTableAccess(importer, own, ['write'])).toBe(true)
    expect(pluginHasContentTableAccess(importer, own, ['delete'])).toBe(false)
  })

  it('rejects tables created by a different plugin', () => {
    expect(pluginHasContentTableAccess(importer, table('runtime-products', 'other.importer'), ['read'])).toBe(false)
  })

  it('rejects user-created tables (null creator)', () => {
    expect(pluginHasContentTableAccess(importer, table('customers', null), ['read'])).toBe(false)
  })

  it('never matches by slug — a table literally slugged like the marker stays inaccessible', () => {
    expect(pluginHasContentTableAccess(importer, table(OWN_CREATED_TABLES_MARKER, null), ['read'])).toBe(false)
  })
})

describe('content table access — union of matching entries', () => {
  it('allows a mode declared by ANY matching entry', () => {
    // The slug entry narrows `forms` to read; the marker adds write for the
    // same (own-created) table. Union semantics: both modes are allowed.
    const entry = pluginRecord('acme.forms', [
      { table: 'forms', modes: ['read'] },
      { table: OWN_CREATED_TABLES_MARKER, modes: ['write'] },
    ])
    const ownForms = table('forms', 'acme.forms')
    expect(pluginHasContentTableAccess(entry, ownForms, ['read'])).toBe(true)
    expect(pluginHasContentTableAccess(entry, ownForms, ['write'])).toBe(true)
    expect(pluginHasContentTableAccess(entry, ownForms, ['publish'])).toBe(false)
  })
})

describe('pluginHasContentTableAccess — one answer for permission and entry', () => {
  it('needs every mode declared for the table AND its permission granted', () => {
    const entry = pluginRecord('acme.importer', [
      { table: 'posts', modes: ['write'] },
      { table: OWN_CREATED_TABLES_MARKER, modes: ['read', 'write'] },
    ])
    entry.manifest.grantedPermissions = ['cms.content.read', 'cms.content.write']
    // Declared for write only: listing, searching and reading are not covered.
    expect(pluginHasContentTableAccess(entry, table('posts', null), ['read'])).toBe(false)
    expect(pluginHasContentTableAccess(entry, table('posts', null), ['write'])).toBe(true)
    expect(pluginHasContentTableAccess(entry, table('posts', null), ['read', 'write'])).toBe(false)
    expect(pluginHasContentTableAccess(entry, table('runtime-products', 'acme.importer'), ['read', 'write'])).toBe(true)
    expect(pluginHasContentTableAccess(entry, table('runtime-products', 'other.plugin'), ['read'])).toBe(false)
    expect(pluginHasContentTableAccess(entry, table('customers', null), ['read'])).toBe(false)

    // The entry alone is not enough: the permission must have been granted.
    entry.manifest.grantedPermissions = ['cms.content.read']
    expect(pluginHasContentTableAccess(entry, table('posts', null), ['write'])).toBe(false)
  })
})
