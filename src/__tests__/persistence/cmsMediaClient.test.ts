import { describe, expect, it } from 'bun:test'
import {
  deleteCmsMediaAsset,
  findCmsMediaByContentHash,
  listCmsMediaAssets,
  renameCmsMediaAsset,
  uploadCmsMediaAsset,
} from '@core/persistence/cmsMedia'

describe('CMS media client', () => {
  it('lists media assets with session credentials', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

    const assets = await listCmsMediaAssets({ fetchImpl: async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({
        assets: [{
          id: 'asset_1',
          filename: 'hero.png',
          mimeType: 'image/png',
          sizeBytes: 12,
          publicPath: '/uploads/asset_1-hero.png',
          uploadedByUserId: null,
          createdAt: '2026-01-03T00:00:00.000Z',
        }],
      }), { status: 200 })
    } })

    expect(assets).toHaveLength(1)
    expect(assets[0].publicPath).toBe('/uploads/asset_1-hero.png')
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/media',
      init: { method: 'GET', credentials: 'include' },
    })
  })

  it('uploads one file as multipart form data with session credentials', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const file = new File(['image-bytes'], 'hero.png', { type: 'image/png' })

    const asset = await uploadCmsMediaAsset(file, { fetchImpl: async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({
        asset: {
          id: 'asset_1',
          filename: 'hero.png',
          mimeType: 'image/png',
          sizeBytes: 12,
          publicPath: '/uploads/asset_1-hero.png',
          uploadedByUserId: null,
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      }), { status: 201 })
    } })

    expect(asset.filename).toBe('hero.png')
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/media',
      init: { method: 'POST', credentials: 'include' },
    })
    expect(calls[0].init?.body).toBeInstanceOf(FormData)
  })

  it('renames a media asset with session credentials', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

    const asset = await renameCmsMediaAsset('media-1', 'Hero renamed.png', { fetchImpl: async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({
        asset: {
          id: 'media-1',
          filename: 'Hero renamed.png',
          mimeType: 'image/png',
          sizeBytes: 12,
          publicPath: '/uploads/asset_1-hero.png',
          uploadedByUserId: null,
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      }), { status: 200 })
    } })

    expect(asset.filename).toBe('Hero renamed.png')
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/media/media-1',
      init: {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
      },
    })
    expect(calls[0].init?.body).toBe(JSON.stringify({ filename: 'Hero renamed.png' }))
  })

  it('deletes a media asset with session credentials', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

    await deleteCmsMediaAsset('media-1', { fetchImpl: async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    } })

    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/media/media-1',
      init: {
        method: 'DELETE',
        credentials: 'include',
      },
    })
  })

  it('surfaces API errors from the response body', async () => {
    await expect(
      listCmsMediaAssets({ fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }),
    ).rejects.toThrow('Unauthorized')
  })
})

describe('findCmsMediaByContentHash', () => {
  it('splits a lookup larger than the server accepts into several requests', async () => {
    const bodies: string[][] = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { contentHashes } = JSON.parse(String(init?.body)) as { contentHashes: string[] }
      bodies.push(contentHashes)
      return new Response(JSON.stringify({
        matches: [{ contentHash: contentHashes[0], id: `a${bodies.length}`, publicPath: '/uploads/x', filename: 'x' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const hashes = Array.from({ length: 10_001 }, (_, i) => i.toString(16).padStart(64, '0'))

    const matches = await findCmsMediaByContentHash(hashes, { fetchImpl })

    expect(bodies.map((b) => b.length)).toEqual([10_000, 1])
    expect(matches.map((m) => m.id)).toEqual(['a1', 'a2'])
  })
})
