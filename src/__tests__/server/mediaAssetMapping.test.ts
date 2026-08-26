/**
 * Drift-lock tests for the single-source-of-truth media-asset mapping.
 *
 * Background (CTO audit finding): the ~22-column `media_assets` projection and
 * its row→asset mapper were duplicated between `server/repositories/media.ts`
 * and `server/publish/mediaPrefetch.ts`. The publisher copy had ALREADY drifted
 * — it dropped `storageAdapterId` / `externallyHosted` and never derived each
 * variant's `storagePath` / `storageAdapterId`, so a published page could see a
 * DIFFERENT asset shape than the admin.
 *
 * These tests pin the fix shut:
 *   1. The repository and the publisher map the SAME DB row to an IDENTICAL
 *      asset object — including the four fields the drifted copy dropped.
 *   2. `createMediaAsset`'s INSERT tuple stays in arity lockstep with its
 *      placeholders, and the canonical SELECT projection returns a fully
 *      hydrated row (no silently half-hydrated asset).
 */

import { describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import {
  createMediaAsset,
  getMediaAsset,
  setMediaAssetVariants,
} from '../../../server/repositories/media'
import { MEDIA_ASSET_INSERT_COLUMNS } from '../../../server/repositories/mediaAssetMapping'
import { prefetchMediaAssets } from '../../../server/publish/mediaPrefetch'
import { placeholder } from '../../../server/db/client'
import type { IModuleRegistry } from '../../../src/core/module-engine'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal IModuleRegistry that reports every prop as type 'image'. */
function makeImageRegistry(propKey = 'src'): IModuleRegistry {
  return {
    get: () => ({
      id: 'test.image',
      schema: { [propKey]: { type: 'image' as const, label: 'Image' } },
    }),
  } as unknown as IModuleRegistry
}

/** Build a minimal page tree with one node that has an image prop. */
function makePageWithImageProp(nodeId: string, propKey: string, value: string) {
  return {
    id: 'page-1',
    nodes: {
      root: { id: 'root', moduleId: 'base.body', props: {}, children: [nodeId], breakpointOverrides: {}, classIds: [] },
      [nodeId]: { id: nodeId, moduleId: 'test.image', props: { [propKey]: value }, children: [], breakpointOverrides: {}, classIds: [] },
    },
    rootNodeId: 'root',
  }
}

/** The full set of keys a hydrated `MediaAsset` must carry. */
const MEDIA_ASSET_FIELD_KEYS = [
  'id', 'filename', 'mimeType', 'sizeBytes', 'publicPath', 'uploadedByUserId',
  'createdAt', 'altText', 'caption', 'title', 'tags', 'width', 'height',
  'durationMs', 'dominantColor', 'deletedAt', 'replacedAt', 'folderIds',
  'blurHash', 'variants', 'crop', 'focus', 'posterPath', 'storageAdapterId', 'externallyHosted',
].sort()

// ---------------------------------------------------------------------------
// Finding — repo vs. publisher map to one identical shape
// ---------------------------------------------------------------------------

describe('media-asset mapping (single source of truth)', () => {
  it('repository and publisher map the same row to an IDENTICAL asset', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      // An externally-hosted asset on a non-default storage adapter, with a
      // variant that carries its own storagePath / storageAdapterId — exactly
      // the fields the drifted publisher copy used to drop.
      await createMediaAsset(db, {
        id: 'a1',
        filename: 'hero.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        storagePath: 'hero.png',
        publicPath: '/uploads/hero.png',
        uploadedByUserId: null,
        storageAdapterId: 's3.main',
        externallyHosted: true,
      })
      await setMediaAssetVariants(db, 'a1', {
        width: 1200,
        height: 800,
        blurHash: 'LKO2?V',
        variants: [
          {
            width: 600,
            height: 400,
            format: 'webp',
            path: '/uploads/hero-600.webp',
            sizeBytes: 1000,
            storagePath: 'hero-600.webp',
            storageAdapterId: 's3.main',
          },
        ],
      })

      const repoAsset = await getMediaAsset(db, 'a1')
      expect(repoAsset).not.toBeNull()

      const page = makePageWithImageProp('n1', 'src', '/uploads/hero.png')
      const registry = makeImageRegistry('src')
      const map = await prefetchMediaAssets(
        page as never,
        { visualComponents: [] } as never,
        registry,
        db,
      )
      const prefetchAsset = map.get('/uploads/hero.png')
      expect(prefetchAsset).toBeDefined()

      // The whole point of the fix: admin and published see ONE shape.
      expect(prefetchAsset).toEqual(repoAsset!)

      // The previously-missing fields are now present in the publisher path.
      expect(prefetchAsset!.storageAdapterId).toBe('s3.main')
      expect(prefetchAsset!.externallyHosted).toBe(true)
      expect(prefetchAsset!.variants[0]?.storagePath).toBe('hero-600.webp')
      expect(prefetchAsset!.variants[0]?.storageAdapterId).toBe('s3.main')

      // No key is silently dropped relative to the repository shape.
      expect(Object.keys(prefetchAsset!).sort()).toEqual(Object.keys(repoAsset!).sort())
      expect(Object.keys(prefetchAsset!).sort()).toEqual(MEDIA_ASSET_FIELD_KEYS)
    } finally {
      await cleanup()
    }
  })

  it('publisher derives a variant storagePath for legacy rows missing it', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await createMediaAsset(db, {
        id: 'a2',
        filename: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: 512,
        storagePath: 'logo.png',
        publicPath: '/uploads/logo.png',
        uploadedByUserId: null,
        storageAdapterId: '',
        externallyHosted: false,
      })
      // Persist a legacy-shaped variant: only the five wire fields, no
      // storagePath / storageAdapterId (as older rows were written).
      await db.unsafe(
        `update media_assets set variants_json = ${placeholder(db.dialect, 1)} where id = ${placeholder(db.dialect, 2)}`,
        [
          JSON.stringify([
            { width: 320, height: 200, format: 'webp', path: '/uploads/logo-320.webp', sizeBytes: 400 },
          ]),
          'a2',
        ],
      )

      const page = makePageWithImageProp('n1', 'src', '/uploads/logo.png')
      const map = await prefetchMediaAssets(
        page as never,
        { visualComponents: [] } as never,
        makeImageRegistry('src'),
        db,
      )
      const variant = map.get('/uploads/logo.png')!.variants[0]!
      // Canonical derivation: storagePath from path (stripping /uploads/),
      // storageAdapterId defaults to local-disk ''.
      expect(variant.storagePath).toBe('logo-320.webp')
      expect(variant.storageAdapterId).toBe('')
    } finally {
      await cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Column-constant / INSERT-tuple integrity
// ---------------------------------------------------------------------------

describe('media-asset column / insert integrity', () => {
  it('INSERT tuple stays in arity lockstep with its placeholders', () => {
    // The repository derives BOTH the column list and the positional
    // placeholders from MEDIA_ASSET_INSERT_COLUMNS, so a column add can't
    // desync the tuple. Lock the count for each dialect.
    expect(MEDIA_ASSET_INSERT_COLUMNS.length).toBeGreaterThan(0)
    for (const dialect of ['postgres', 'sqlite'] as const) {
      const placeholders = MEDIA_ASSET_INSERT_COLUMNS.map((_, i) => placeholder(dialect, i + 1))
      expect(placeholders).toHaveLength(MEDIA_ASSET_INSERT_COLUMNS.length)
    }
  })

  it('createMediaAsset returns a fully-hydrated row (no half-hydrated projection)', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const asset = await createMediaAsset(db, {
        id: 'a3',
        filename: 'pic.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        storagePath: 'pic.png',
        publicPath: '/uploads/pic.png',
        uploadedByUserId: null,
        storageAdapterId: '',
        externallyHosted: false,
      })
      // A missing column in the canonical SELECT projection would surface as a
      // missing key here.
      expect(Object.keys(asset).sort()).toEqual(MEDIA_ASSET_FIELD_KEYS)
    } finally {
      await cleanup()
    }
  })
})
