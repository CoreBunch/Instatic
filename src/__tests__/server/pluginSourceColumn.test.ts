/**
 * `installed_plugins.source` — provenance column added by migration 022.
 * Zip/JSON installs default to 'installed'; site plugin activations pass
 * { source: 'site-local' }. The value must round-trip reads and survive the
 * upgrade upsert.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { parsePluginManifest } from '@core/plugins/manifest'
import { getInstalledPlugin, installPlugin } from '../../../server/repositories/plugins'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

function manifest(id: string, version = '1.0.0') {
  return parsePluginManifest({
    id,
    name: id,
    version,
    apiVersion: 1,
    permissions: [],
    resources: [],
    adminPages: [],
  })
}

let testDb: TestDb

beforeAll(async () => {
  testDb = await createTestDb()
})

afterAll(async () => {
  await testDb.cleanup()
})

describe('installed_plugins.source', () => {
  test('defaults to installed and round-trips site-local', async () => {
    const { db } = testDb

    const installed = await installPlugin(db, manifest('acme.demo'), [])
    expect(installed.source).toBe('installed')

    const siteLocal = await installPlugin(db, manifest('site.demo', '1.0.1+aaaa1111'), [], {
      source: 'site-local',
    })
    expect(siteLocal.source).toBe('site-local')

    const read = await getInstalledPlugin(db, 'site.demo')
    expect(read?.kind).toBe('ok')
    if (read?.kind === 'ok') expect(read.plugin.source).toBe('site-local')
  })

  test('upgrade upsert preserves the site-local provenance', async () => {
    const { db } = testDb
    const upgraded = await installPlugin(db, manifest('site.demo', '1.0.2+bbbb2222'), [], {
      source: 'site-local',
    })
    expect(upgraded.source).toBe('site-local')
    expect(upgraded.version).toBe('1.0.2+bbbb2222')
  })
})
