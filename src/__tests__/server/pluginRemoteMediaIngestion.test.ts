import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { upsertRemoteMediaAsset } from '../../../server/media/remoteIngestion'

const PLUGIN_ID = 'au.example.vaultre'

const FIRST_PNG = new Uint8Array(
  await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 180, g: 90, b: 30, alpha: 1 } },
  }).png().toBuffer(),
)

const REPLACEMENT_PNG = new Uint8Array(
  await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 30, g: 90, b: 180, alpha: 1 } },
  }).png().toBuffer(),
)

describe('plugin remote media ingestion', () => {
  let testDb: TestDb
  let uploadsDir: string

  beforeEach(async () => {
    testDb = await createTestDb()
    await testDb.db`
      insert into installed_plugins (id, name, version, manifest_json)
      values (${PLUGIN_ID}, ${'VaultRE Test'}, ${'1.0.0'}, ${JSON.stringify({
        id: PLUGIN_ID,
        name: 'VaultRE Test',
        version: '1.0.0',
        apiVersion: 1,
        permissions: ['media.import.remote', 'network.outbound'],
        networkAllowedHosts: ['cdn.example.com'],
      })})
    `
    uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-remote-media-'))
    mediaStorageRegistry.configureLocalDisk({ uploadsDir })
  })

  afterEach(async () => {
    mediaStorageRegistry.__reset()
    await testDb.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('creates once, skips an unchanged source version, and replaces in place', async () => {
    let upstreamBytes = FIRST_PNG
    let fetchCount = 0
    const deps = {
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl: (async () => {
        fetchCount += 1
        return new Response(upstreamBytes, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }) as typeof fetch,
    }

    const first = await upsertRemoteMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      input: {
        sourceKey: 'listing-42:photo-7',
        sourceUrl: 'https://cdn.example.com/listing-42/photo-7.png',
        sourceVersion: 'v1',
        filename: 'front-elevation.png',
        altText: 'Front elevation of 42 Example Street',
      },
    }, deps)

    expect(first.status).toBe('created')
    expect(first.asset.width).toBe(4)
    expect(first.asset.altText).toBe('Front elevation of 42 Example Street')

    const unchanged = await upsertRemoteMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      input: {
        sourceKey: 'listing-42:photo-7',
        sourceUrl: 'https://cdn.example.com/listing-42/photo-7.png',
        sourceVersion: 'v1',
        filename: 'front-elevation.png',
        altText: 'Updated front elevation description',
      },
    }, deps)

    expect(unchanged.status).toBe('unchanged')
    expect(unchanged.asset.id).toBe(first.asset.id)
    expect(unchanged.asset.altText).toBe('Updated front elevation description')
    expect(fetchCount).toBe(1)

    upstreamBytes = REPLACEMENT_PNG
    const replaced = await upsertRemoteMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      input: {
        sourceKey: 'listing-42:photo-7',
        sourceUrl: 'https://cdn.example.com/listing-42/photo-7.png',
        sourceVersion: 'v2',
        filename: 'front-elevation.png',
        altText: 'Updated front elevation description',
      },
    }, deps)

    expect(replaced.status).toBe('replaced')
    expect(replaced.asset.id).toBe(first.asset.id)
    expect(replaced.asset.width).toBe(8)
    expect(fetchCount).toBe(2)
  })

  it('enforces the plugin network allowlist before downloading', async () => {
    await expect(upsertRemoteMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['api.vaultre.com.au'],
      input: {
        sourceKey: 'listing-42:photo-7',
        sourceUrl: 'https://untrusted.example/photo.png',
        sourceVersion: 'v1',
        filename: 'photo.png',
      },
    }, {
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl: (async () => new Response(FIRST_PNG)) as typeof fetch,
    })).rejects.toThrow(/not in the networkAllowedHosts allowlist/)
  })

  it('rejects a redirect that downgrades the media download to HTTP', async () => {
    let fetchCount = 0
    await expect(upsertRemoteMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      input: {
        sourceKey: 'listing-42:photo-8',
        sourceUrl: 'https://cdn.example.com/photo.png',
        filename: 'photo.png',
      },
    }, {
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl: (async () => {
        fetchCount += 1
        return new Response(null, {
          status: 302,
          headers: { location: 'http://cdn.example.com/photo.png' },
        })
      }) as typeof fetch,
    })).rejects.toThrow(/only supports https:/)
    expect(fetchCount).toBe(1)
  })

  it('uses the content hash when the upstream has no source version', async () => {
    let fetchCount = 0
    const deps = {
      resolveHost: async () => ['93.184.216.34'],
      fetchImpl: (async () => {
        fetchCount += 1
        return new Response(FIRST_PNG)
      }) as typeof fetch,
    }
    const input = {
      sourceKey: 'listing-42:photo-9',
      sourceUrl: 'https://cdn.example.com/photo-9.png',
      filename: 'photo-9.png',
    }

    const created = await upsertRemoteMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      input,
    }, deps)
    const unchanged = await upsertRemoteMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      input,
    }, deps)

    expect(created.status).toBe('created')
    expect(unchanged.status).toBe('unchanged')
    expect(unchanged.asset.id).toBe(created.asset.id)
    expect(fetchCount).toBe(2)
  })
})
