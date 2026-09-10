/**
 * Architecture gates for the cms.content plugin API surface.
 *
 * Replaces the deleted `plugin-cms-pages-surface.test.ts` — see
 * `docs/plans/2026-05-30-plugin-cms-content-access.md` for the rollout.
 *
 * Verifies that all sync-points for the five new permissions are present
 * (PLUGIN_PERMISSION_VALUES, capability matrix, permission alias builder),
 * that the SDK type surface exposes the methods, and that the host-side
 * dispatch wires everything up.
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

describe('cms.content plugin API surface', () => {
  it('ServerPluginApi.cms exposes content.tables / content.table / content.tree', async () => {
    const source = await read('src/core/plugin-sdk/types/serverApi.ts')
    expect(source).toContain('content: {')
    expect(source).toContain('tables: {')
    expect(source).toContain('table: (slug: string)')
    expect(source).toContain('tree: (entryId: string, fieldId: string, options?: ContentLocaleOptions)')
    expect(source).toContain('locales: { list:')
    expect(source).toContain('unpublish:')
    expect(source).toContain('search:')
    expect(source).toContain('getPublishedSnapshot:')
    expect(source).toContain('republishAll:')
  })

  it('cms.content.* permissions are in PLUGIN_PERMISSION_VALUES', async () => {
    const source = await read('src/core/plugin-sdk/types/permissions.ts')
    expect(source).toContain("'cms.content.read'")
    expect(source).toContain("'cms.content.write'")
    expect(source).toContain("'cms.content.publish'")
    expect(source).toContain("'cms.content.delete'")
    expect(source).toContain("'cms.content.tables.manage'")
  })

  it('cms.content.* permissions are in PLUGIN_CAPABILITIES', async () => {
    const source = await read('src/core/plugin-sdk/capabilities.ts')
    expect(source).toContain("permission: 'cms.content.read'")
    expect(source).toContain("permission: 'cms.content.write'")
    expect(source).toContain("permission: 'cms.content.publish'")
    expect(source).toContain("permission: 'cms.content.delete'")
    expect(source).toContain("permission: 'cms.content.tables.manage'")
  })

  it('network.outbound is in PLUGIN_CAPABILITIES (was missing — regression guard)', async () => {
    const source = await read('src/core/plugin-sdk/capabilities.ts')
    expect(source).toContain("permission: 'network.outbound'")
  })

  it('cms.content.* aliases exist in builders/permissions.ts', async () => {
    const source = await read('src/core/plugin-sdk/builders/permissions.ts')
    expect(source).toContain("cmsContentRead: 'cms.content.read'")
    expect(source).toContain("cmsContentWrite: 'cms.content.write'")
    expect(source).toContain("cmsContentPublish: 'cms.content.publish'")
    expect(source).toContain("cmsContentDelete: 'cms.content.delete'")
    expect(source).toContain("cmsContentTablesManage: 'cms.content.tables.manage'")
  })

  it('cms.content RPC targets are in the ApiCallSchemas record (SSOT)', async () => {
    const source = await read('server/plugins/protocol/apiCallSchema.ts')
    expect(source).toContain("'cms.content.tables.list'")
    expect(source).toContain("'cms.content.tables.get'")
    expect(source).toContain("'cms.content.tables.create'")
    expect(source).toContain("'cms.content.entries.list'")
    expect(source).toContain("'cms.content.entries.get'")
    expect(source).toContain("'cms.content.entries.getBySlug'")
    expect(source).toContain("'cms.content.entries.create'")
    expect(source).toContain("'cms.content.entries.update'")
    expect(source).toContain("'cms.content.entries.delete'")
    expect(source).toContain("'cms.content.entries.publish'")
    expect(source).toContain("'cms.content.entries.moveTable'")
    expect(source).toContain("'cms.content.entries.createMany'")
    expect(source).toContain("'cms.content.entries.updateMany'")
    expect(source).toContain("'cms.content.entries.deleteMany'")
    expect(source).toContain("'cms.content.tree.read'")
    expect(source).toContain("'cms.content.tree.mutate'")
    expect(source).toContain("'cms.content.tree.replace'")
    expect(source).toContain("'cms.content.search'")
    expect(source).toContain("'cms.content.snapshot'")
    expect(source).toContain("'cms.content.republishAll'")
  })

  it('quickjs plugin runtime exposes api.cms.content.{tables,table,tree,...}', async () => {
    const source = await read('server/plugins/quickjs/bootstrap/src/buildApi.ts')
    expect(source).toContain('content: {')
    expect(source).toContain("'cms.content.tables.list'")
    expect(source).toContain("'cms.content.entries.list'")
    expect(source).toContain("'cms.content.tree.mutate'")
    expect(source).toContain("'cms.content.republishAll'")
  })

  it('apiDispatch.ts dispatches the content targets', async () => {
    const source = await read('server/plugins/host/apiDispatch.ts')
    expect(source).toContain("'cms.content.tables.list':")
    expect(source).toContain("'cms.content.entries.create':")
    expect(source).toContain("'cms.content.tree.mutate':")
    expect(source).toContain("'cms.content.republishAll':")
  })

  it('legacy cms.pages.* surface is gone', async () => {
    const targets = await read('server/plugins/protocol/apiCallSchema.ts')
    expect(targets).not.toContain("'cms.pages.list'")
    expect(targets).not.toContain("'cms.pages.republish'")
    expect(targets).not.toContain("'cms.pages.republishAll'")

    const permissions = await read('src/core/plugin-sdk/types/permissions.ts')
    expect(permissions).not.toContain("'cms.pages.read'")
    expect(permissions).not.toContain("'cms.pages.publish'")
  })

  it('contentAccess[] manifest field is declared', async () => {
    const manifest = await read('src/core/plugins/manifest.ts')
    expect(manifest).toContain('contentAccess')
    const types = await read('src/core/plugin-sdk/types/manifest.ts')
    expect(types).toContain('contentAccess?:')
  })
})
