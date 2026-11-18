import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Value } from '@sinclair/typebox/value'
import sharp from 'sharp'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { MediaUpsertInputSchema } from '@core/plugin-sdk'
import { upsertMediaAsset } from '../../../server/media/ingestion'

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

describe('plugin media ingestion', () => {
  let testDb: TestDb
  let uploadsDir: string
  let pluginAssetRoot: string

  beforeEach(async () => {
    testDb = await createTestDb()
    await testDb.db`
      insert into installed_plugins (id, name, version, manifest_json)
      values (${PLUGIN_ID}, ${'VaultRE Test'}, ${'1.0.0'}, ${JSON.stringify({
        id: PLUGIN_ID,
        name: 'VaultRE Test',
        version: '1.0.0',
        apiVersion: 1,
        permissions: ['media.import', 'network.outbound'],
        networkAllowedHosts: ['cdn.example.com'],
      })})
    `
    uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-remote-media-'))
    pluginAssetRoot = join(uploadsDir, 'plugins', PLUGIN_ID, '1.0.0')
    await mkdir(join(pluginAssetRoot, 'assets'), { recursive: true })
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

    const first = await upsertMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      pluginAssetRoot,
      input: {
        sourceKey: 'listing-42:photo-7',
        source: {
          kind: 'remote',
          url: 'https://cdn.example.com/listing-42/photo-7.png',
        },
        sourceVersion: 'v1',
        filename: 'front-elevation.png',
        altText: 'Front elevation of 42 Example Street',
      },
    }, deps)

    expect(first.status).toBe('created')
    expect(first.asset.width).toBe(4)
    expect(first.asset.altText).toBe('Front elevation of 42 Example Street')

    const unchanged = await upsertMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      pluginAssetRoot,
      input: {
        sourceKey: 'listing-42:photo-7',
        source: {
          kind: 'remote',
          url: 'https://cdn.example.com/listing-42/photo-7.png',
        },
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
    const replaced = await upsertMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      pluginAssetRoot,
      input: {
        sourceKey: 'listing-42:photo-7',
        source: {
          kind: 'remote',
          url: 'https://cdn.example.com/listing-42/photo-7.png',
        },
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
    await expect(upsertMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['api.vaultre.com.au'],
      pluginAssetRoot,
      input: {
        sourceKey: 'listing-42:photo-7',
        source: { kind: 'remote', url: 'https://untrusted.example/photo.png' },
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
    await expect(upsertMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      pluginAssetRoot,
      input: {
        sourceKey: 'listing-42:photo-8',
        source: { kind: 'remote', url: 'https://cdn.example.com/photo.png' },
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
      source: { kind: 'remote' as const, url: 'https://cdn.example.com/photo-9.png' },
      filename: 'photo-9.png',
    }

    const created = await upsertMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      pluginAssetRoot,
      input,
    }, deps)
    const unchanged = await upsertMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: ['cdn.example.com'],
      pluginAssetRoot,
      input,
    }, deps)

    expect(created.status).toBe('created')
    expect(unchanged.status).toBe('unchanged')
    expect(unchanged.asset.id).toBe(created.asset.id)
    expect(fetchCount).toBe(2)
  })

  it('imports and replaces a contained plugin-package asset', async () => {
    const assetPath = join(pluginAssetRoot, 'assets', 'default-hero.png')
    await writeFile(assetPath, FIRST_PNG)
    const input = {
      sourceKey: 'default-hero',
      source: { kind: 'pluginAsset' as const, path: 'assets/default-hero.png' },
      sourceVersion: '1.0.0',
      filename: 'default-hero.png',
      altText: 'Default hero image',
    }

    const created = await upsertMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: [],
      pluginAssetRoot,
      input,
    })
    await writeFile(assetPath, REPLACEMENT_PNG)
    const replaced = await upsertMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: [],
      pluginAssetRoot,
      input: { ...input, sourceVersion: '1.1.0' },
    })

    expect(created.status).toBe('created')
    expect(created.asset.width).toBe(4)
    expect(replaced.status).toBe('replaced')
    expect(replaced.asset.id).toBe(created.asset.id)
    expect(replaced.asset.width).toBe(8)
  })

  it('refuses plugin-package paths outside the installed asset root', async () => {
    const outsidePath = join(pluginAssetRoot, '..', 'outside.png')
    await writeFile(outsidePath, FIRST_PNG)

    await expect(upsertMediaAsset(testDb.db, {
      pluginId: PLUGIN_ID,
      networkAllowedHosts: [],
      pluginAssetRoot,
      input: {
        sourceKey: 'outside',
        source: { kind: 'pluginAsset', path: '../outside.png' },
        filename: 'outside.png',
      },
    })).rejects.toThrow(/escapes (?:allowed )?root/)
  })

  it('rejects absolute and traversal package paths at the protocol schema', () => {
    const input = {
      sourceKey: 'starter:hero',
      source: { kind: 'pluginAsset', path: 'assets/hero.png' },
      filename: 'hero.png',
    }
    expect(Value.Check(MediaUpsertInputSchema, input)).toBe(true)
    expect(Value.Check(MediaUpsertInputSchema, {
      ...input,
      source: { kind: 'pluginAsset', path: '../hero.png' },
    })).toBe(false)
    expect(Value.Check(MediaUpsertInputSchema, {
      ...input,
      source: { kind: 'pluginAsset', path: '/etc/passwd' },
    })).toBe(false)
  })
})
