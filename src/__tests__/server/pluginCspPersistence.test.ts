import { afterEach, describe, expect, it } from 'bun:test'
import { parsePluginManifest } from '@core/plugins/manifest'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import {
  createPluginRecord,
  installPlugin,
  setPluginEnabled,
} from '../../../server/repositories/plugins'
import {
  collectFrontendInjections,
  injectFrontendAssets,
} from '../../../server/publish/frontendInjections'
import { handlePluginRecordsCollection } from '../../../server/handlers/cms/plugins/records'
import type { AuthUser } from '../../../server/repositories/users'
import { createFakeDb } from './dbTestFake'

const PAGE = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'none\'; connect-src \'self\';">'

const manifest = parsePluginManifest({
  id: 'instatic.csp-manager',
  name: 'CSP Manager',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['admin.navigation', 'publisher.csp'],
  publisher: { csp: { resource: 'sources' } },
  resources: [{
    id: 'sources',
    title: 'CSP sources',
    fields: [
      { id: 'directive', label: 'Directive', type: 'text', required: true },
      { id: 'origin', label: 'HTTPS origin', type: 'text', required: true },
      { id: 'enabled', label: 'Enabled', type: 'boolean', required: true },
      { id: 'description', label: 'Description', type: 'longtext' },
    ],
  }],
  adminPages: [{
    id: 'policy',
    title: 'CSP Manager',
    content: { kind: 'resource', heading: 'CSP Manager', resource: 'sources' },
  }],
})

let testDb: TestDb | null = null

afterEach(async () => {
  await testDb?.cleanup()
  testDb = null
})

describe('CSP Manager persistence and permission containment', () => {
  it('reloads deterministic enabled records and removes them when the plugin is disabled', async () => {
    testDb = await createTestDb()
    await installPlugin(testDb.db, manifest, ['admin.navigation', 'publisher.csp'])
    await createPluginRecord(testDb.db, {
      id: 'z-script',
      pluginId: manifest.id,
      resourceId: 'sources',
      data: { directive: 'script-src', origin: 'https://connect.facebook.net', enabled: true },
    })
    await createPluginRecord(testDb.db, {
      id: 'a-connect',
      pluginId: manifest.id,
      resourceId: 'sources',
      data: { directive: 'connect-src', origin: 'https://graph.facebook.com', enabled: true },
    })
    await createPluginRecord(testDb.db, {
      id: 'disabled-frame',
      pluginId: manifest.id,
      resourceId: 'sources',
      data: { directive: 'frame-src', origin: 'https://www.youtube.com', enabled: false },
    })

    const first = await collectFrontendInjections(testDb.db)
    const reloaded = await collectFrontendInjections(testDb.db)
    expect(reloaded.cspSources).toEqual(first.cspSources)
    expect(reloaded.cspSources).toEqual([
      { directive: 'connect-src', origin: 'https://graph.facebook.com', enabled: true },
      { directive: 'script-src', origin: 'https://connect.facebook.net', enabled: true },
    ])
    const html = injectFrontendAssets(PAGE, reloaded)
    expect(html).toContain("connect-src 'self' https://graph.facebook.com")
    expect(html).toContain('script-src https://connect.facebook.net')
    expect(html).not.toContain('youtube.com')

    await setPluginEnabled(testDb.db, manifest.id, false)
    expect((await collectFrontendInjections(testDb.db)).cspSources).toEqual([])
  })

  it('ignores records when publisher.csp was not granted', async () => {
    testDb = await createTestDb()
    await installPlugin(testDb.db, manifest, ['admin.navigation'])
    await createPluginRecord(testDb.db, {
      id: 'ungranted',
      pluginId: manifest.id,
      resourceId: 'sources',
      data: { directive: 'script-src', origin: 'https://evil.example', enabled: true },
    })
    expect((await collectFrontendInjections(testDb.db)).cspSources).toEqual([])
  })

  it('rejects an invalid save before any persistence mutation', async () => {
    let mutated = false
    const db = createFakeDb(async (sql) => {
      if (sql.includes('from installed_plugins')) {
        return {
          rows: [{
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            enabled: true,
            lifecycle_status: 'active',
            last_error: null,
            granted_permissions_json: ['admin.navigation', 'publisher.csp'],
            manifest_json: JSON.parse(JSON.stringify(manifest)),
            settings_json: {},
            installed_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          }],
          rowCount: 1,
        }
      }
      mutated = true
      return { rows: [], rowCount: 0 }
    })
    const request = new Request(
      `https://example.com/admin/api/cms/plugins/${manifest.id}/resources/sources/records`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: { directive: 'script-src', origin: 'https://example.com/path', enabled: true },
        }),
      },
    )

    const response = await handlePluginRecordsCollection(
      request,
      db,
      { id: 'admin' } as AuthUser,
      manifest.id,
      'sources',
    )
    expect(response.status).toBe(400)
    expect(mutated).toBe(false)
  })
})
