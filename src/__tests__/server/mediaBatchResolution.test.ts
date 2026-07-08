/**
 * Focused tests for the batched media-resolution helpers.
 *
 * Finding 1 — resolveMediaIdsToPaths (src/core/loops/sources/dataRows.ts):
 *   Verifies that N media-id lookups collapse into ONE query (not N), that
 *   repeated ids are deduplicated before the query, and that ids absent from
 *   the database are absent from the returned map.
 *
 * Finding 2 — prefetchMediaAssets (server/publish/mediaPrefetch.ts):
 *   Verifies that N path lookups collapse into ONE query, and that paths
 *   absent from the database are absent from the returned map.
 *
 * Both sets of tests run against an in-memory bun:sqlite DbClient (via
 * createTestDb) OR against a query-counting createFakeDb for the zero-query
 * case where we can't inspect SQLite internals.
 */

import { describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import { createFakeDb } from './dbTestFake'
import { resolveMediaIdsToPaths } from '../../../src/core/loops/sources/dataRows'
import { prefetchMediaAssets } from '../../../server/publish/mediaPrefetch'
import type { IModuleRegistry } from '../../../src/core/module-engine'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertMediaAsset(
  db: Awaited<ReturnType<typeof createTestDb>>['db'],
  id: string,
  publicPath: string,
): Promise<void> {
  await db`
    insert into media_assets
      (id, filename, mime_type, size_bytes, storage_path, public_path,
       storage_adapter_id, externally_hosted)
    values
      (${id}, ${id + '.png'}, 'image/png', 100, ${id + '.png'}, ${publicPath}, '', 0)
  `
}

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

// ---------------------------------------------------------------------------
// Finding 1 — resolveMediaIdsToPaths
// ---------------------------------------------------------------------------

describe('resolveMediaIdsToPaths (Finding 1)', () => {
  it('empty id list → empty map, zero DB queries issued', async () => {
    let queryCount = 0
    const db = createFakeDb(async () => { queryCount++; return { rows: [], rowCount: 0 } })
    const map = await resolveMediaIdsToPaths(db, [])
    expect(map.size).toBe(0)
    expect(queryCount).toBe(0)
  })

  it('N unique ids collapse into exactly ONE query', async () => {
    let queryCount = 0
    const db = createFakeDb(async () => {
      queryCount++
      return {
        rows: [
          { id: 'id-1', public_path: '/uploads/a.png' },
          { id: 'id-2', public_path: '/uploads/b.png' },
          { id: 'id-3', public_path: '/uploads/c.png' },
        ],
        rowCount: 3,
      }
    })
    const map = await resolveMediaIdsToPaths(db, ['id-1', 'id-2', 'id-3'])
    expect(queryCount).toBe(1)
    expect(map.size).toBe(3)
  })

  it('repeated ids are deduplicated — still one query, correct map', async () => {
    let queryCount = 0
    const db = createFakeDb(async () => {
      queryCount++
      return { rows: [{ id: 'id-1', public_path: '/uploads/a.png' }], rowCount: 1 }
    })
    const map = await resolveMediaIdsToPaths(db, ['id-1', 'id-1', 'id-1'])
    expect(queryCount).toBe(1)
    expect(map.size).toBe(1)
    expect(map.get('id-1')).toBe('/uploads/a.png')
  })

  it('ids absent from the DB are absent from the map (real SQLite)', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const map = await resolveMediaIdsToPaths(db, ['nonexistent-1', 'nonexistent-2'])
      expect(map.has('nonexistent-1')).toBe(false)
      expect(map.has('nonexistent-2')).toBe(false)
      expect(map.size).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it('returns correct paths for existing assets, omits missing ones (real SQLite)', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await insertMediaAsset(db, 'm1', '/uploads/hero.png')
      await insertMediaAsset(db, 'm2', '/uploads/thumb.webp')

      const map = await resolveMediaIdsToPaths(db, ['m1', 'm2', 'missing', 'm1'])
      expect(map.size).toBe(2)
      expect(map.get('m1')).toBe('/uploads/hero.png')
      expect(map.get('m2')).toBe('/uploads/thumb.webp')
      expect(map.has('missing')).toBe(false)
    } finally {
      await cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Finding 2 — prefetchMediaAssets
// ---------------------------------------------------------------------------

describe('prefetchMediaAssets (Finding 2)', () => {
  it('page with no image props → empty map, zero DB queries', async () => {
    let queryCount = 0
    const db = createFakeDb(async () => { queryCount++; return { rows: [], rowCount: 0 } })
    const registry = { get: () => ({ id: 'base.text', schema: {} }) } as unknown as IModuleRegistry
    const page = makePageWithImageProp('n1', 'content', 'hello') as never
    const map = await prefetchMediaAssets(page as never, { visualComponents: [] } as never, registry, db)
    expect(map.size).toBe(0)
    expect(queryCount).toBe(0)
  })

  it('N distinct image paths collapse into ONE query', async () => {
    let queryCount = 0
    const db = createFakeDb(async () => {
      queryCount++
      return { rows: [], rowCount: 0 }
    })
    // Build a page with two image nodes so collectMediaPaths yields 2 paths.
    const page = {
      id: 'p',
      nodes: {
        root: { id: 'root', moduleId: 'base.body', props: {}, children: ['n1', 'n2'], breakpointOverrides: {}, classIds: [] },
        n1: { id: 'n1', moduleId: 'test.img', props: { src: '/uploads/a.png' }, children: [], breakpointOverrides: {}, classIds: [] },
        n2: { id: 'n2', moduleId: 'test.img', props: { src: '/uploads/b.png' }, children: [], breakpointOverrides: {}, classIds: [] },
      },
      rootNodeId: 'root',
    }
    const registry = makeImageRegistry('src')
    const map = await prefetchMediaAssets(page as never, { visualComponents: [] } as never, registry, db)
    expect(queryCount).toBe(1)
    expect(map.size).toBe(0) // both paths not in DB → hits absent from map
  })

  it('collects media paths from inline and class background images in the same batched query', async () => {
    let queryCount = 0
    let queriedPaths: unknown[] = []
    const db = createFakeDb(async (_sql, params) => {
      queryCount++
      queriedPaths = params
      return { rows: [], rowCount: 0 }
    })
    const page = {
      id: 'p',
      nodes: {
        root: {
          id: 'root',
          moduleId: 'base.body',
          props: {},
          children: ['n1'],
          breakpointOverrides: {},
          classIds: ['hero-class'],
        },
        n1: {
          id: 'n1',
          moduleId: 'base.container',
          props: {},
          children: [],
          breakpointOverrides: {},
          classIds: [],
          inlineStyles: { backgroundImage: "url('/uploads/inline-bg.png')" },
        },
      },
      rootNodeId: 'root',
    }
    const site = {
      visualComponents: [],
      styleRules: {
        'hero-class': {
          id: 'hero-class',
          name: 'hero',
          kind: 'class',
          selector: { kind: 'class', name: 'hero' },
          order: 0,
          styles: { backgroundImage: "url('/uploads/class-bg.png')" },
          contextStyles: {
            mobile: { backgroundImage: "url('/uploads/mobile-bg.png')" },
          },
          createdAt: 0,
          updatedAt: 0,
        },
      },
    }
    const registry = { get: () => ({ id: 'base.container', schema: {} }) } as unknown as IModuleRegistry

    const map = await prefetchMediaAssets(page as never, site as never, registry, db)

    expect(queryCount).toBe(1)
    expect(queriedPaths.toSorted()).toEqual([
      '/uploads/class-bg.png',
      '/uploads/inline-bg.png',
      '/uploads/mobile-bg.png',
    ])
    expect(map.size).toBe(0)
  })

  it('paths absent from the DB are absent from the returned map (real SQLite)', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const page = makePageWithImageProp('n1', 'src', '/uploads/nonexistent.png')
      const registry = makeImageRegistry('src')
      const map = await prefetchMediaAssets(page as never, { visualComponents: [] } as never, registry, db)
      expect(map.has('/uploads/nonexistent.png')).toBe(false)
      expect(map.size).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it('returns resolved assets for existing paths (real SQLite)', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await insertMediaAsset(db, 'asset-1', '/uploads/hero.png')
      await insertMediaAsset(db, 'asset-2', '/uploads/logo.png')

      const page = {
        id: 'p',
        nodes: {
          root: { id: 'root', moduleId: 'base.body', props: {}, children: ['n1', 'n2'], breakpointOverrides: {}, classIds: [] },
          n1: { id: 'n1', moduleId: 'test.img', props: { src: '/uploads/hero.png' }, children: [], breakpointOverrides: {}, classIds: [] },
          n2: { id: 'n2', moduleId: 'test.img', props: { src: '/uploads/logo.png' }, children: [], breakpointOverrides: {}, classIds: [] },
        },
        rootNodeId: 'root',
      }
      const registry = makeImageRegistry('src')
      const map = await prefetchMediaAssets(page as never, { visualComponents: [] } as never, registry, db)
      expect(map.size).toBe(2)
      expect(map.get('/uploads/hero.png')?.id).toBe('asset-1')
      expect(map.get('/uploads/logo.png')?.id).toBe('asset-2')
    } finally {
      await cleanup()
    }
  })
})
