/**
 * Integration tests for `renderNotFoundResponse` in publicRouter.ts — the
 * dispatcher's fall-through 404 page.
 *
 * Verifies the serving order:
 *   - Layer A: a baked `404.html` artefact in the active slot is served
 *     directly with status 404 (no DB, no render).
 *   - Layer B: with no artefact, the notFound template renders live through
 *     the LRU under the reserved `/404` key — one render per version, every
 *     missed URL shares it, always status 404.
 *   - No notFound template in the published site → null (the dispatcher's
 *     bare JSON 404 takes over), and nothing is cached.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbClient } from '../../../server/db'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import { renderNotFoundResponse } from '../../../server/publish/publicRouter'
import { getStats, resetForTests } from '../../../server/publish/renderCache'
import { createPublishingTestDb, cleanupPublishingTestDbs } from '../helpers/publishingTestDb'
import { createFakeDb } from './dbTestFake'
import { getPublishedRouteInventoryForVersion } from '../../../server/publish/publishedRoutes'
import { getPublishVersion, markPublishedArtefactsCurrent } from '../../../server/publish/publishState'
import { notFoundArtefactPath, swapSlot, writeArtefact, removeArtefactInPlace } from '../../../server/publish/staticArtefact'

afterEach(cleanupPublishingTestDbs)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Site snapshot with (optionally) a notFound template page. */
function makeSnapshot(withNotFound: boolean): PublishedPageSnapshot {
  const notFoundPage = {
    id: 'page_nf',
    title: 'Not found',
    slug: 'not-found',
    rootNodeId: 'root',
    template: { enabled: true, target: { kind: 'notFound' }, priority: 0 },
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.body',
        props: {},
        breakpointOverrides: {},
        children: ['msg'],
      },
      msg: {
        id: 'msg',
        moduleId: 'base.text',
        props: { text: 'This page is missing', tag: 'h1' },
        breakpointOverrides: {},
        children: [],
      },
    },
  }
  return {
    cmsSnapshotVersion: 1,
    pageRowId: withNotFound ? 'page_nf' : 'page_home',
    site: {
      id: 'site_1',
      name: 'Test Site',
      pages: [
        {
          id: 'page_home',
          title: 'Home',
          slug: 'index',
          rootNodeId: 'root',
          nodes: {
            root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [] },
          },
        },
        ...(withNotFound ? [notFoundPage] : []),
      ],
      files: [],
      visualComponents: [],
      breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
      settings: { metaTitle: 'Test Site', shortcuts: {} },
      styleRules: {},
      createdAt: 1000,
      updatedAt: 2000,
    },
  } as unknown as PublishedPageSnapshot
}

async function makePublishedDb(snapshot: PublishedPageSnapshot | null): Promise<DbClient> {
  return createPublishingTestDb(snapshot?.site ?? null)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetForTests()
})

describe('renderNotFoundResponse — Layer B live render', () => {
  it('renders the notFound template with status 404 and caches it', async () => {
    const db = await makePublishedDb(makeSnapshot(true))

    const res1 = await renderNotFoundResponse(db, new URL('http://localhost/nowhere'))
    expect(res1?.status).toBe(404)
    const body = await res1!.text()
    expect(body).toContain('This page is missing')
    expect(getStats()).toMatchObject({ hits: 0, misses: 1, size: 1 })

    // A different missed URL shares the same reserved /404 cache entry.
    const res2 = await renderNotFoundResponse(db, new URL('http://localhost/elsewhere'))
    expect(res2?.status).toBe(404)
    expect(await res2!.text()).toBe(body)
    expect(getStats()).toMatchObject({ hits: 1, misses: 1, size: 1 })
  })

  it('returns null — and caches nothing — when the site has no notFound template', async () => {
    const db = await makePublishedDb(makeSnapshot(false))
    expect(await renderNotFoundResponse(db, new URL('http://localhost/nowhere'))).toBeNull()
    expect(getStats()).toMatchObject({ hits: 0, misses: 1, size: 0 })
  })

  it('returns null when nothing is published at all', async () => {
    const db = await makePublishedDb(null)
    expect(await renderNotFoundResponse(db, new URL('http://localhost/nowhere'))).toBeNull()
  })
})

describe('renderNotFoundResponse — Layer A baked artefact', () => {
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-404-'))
    const slotDir = join(uploadsDir, 'published', 'a')
    await mkdir(slotDir, { recursive: true })
    await writeArtefact(slotDir, notFoundArtefactPath('default'), '<!DOCTYPE html><h1>baked 404</h1>')
    await swapSlot(uploadsDir, 'a')
  })

  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('serves the baked 404 after warming the locale inventory without further SQL', async () => {
    const db = await makePublishedDb(makeSnapshot(true))
    let deny = false
    const explodingDb = createFakeDb(async (sql, params) => {
      if (deny) throw new Error('DB must not be queried after the inventory is warm')
      return db.unsafe(sql, params)
    })
    await getPublishedRouteInventoryForVersion(explodingDb, getPublishVersion())
    markPublishedArtefactsCurrent(getPublishVersion())
    deny = true

    const res = await renderNotFoundResponse(explodingDb, new URL('http://localhost/nope'), uploadsDir)
    expect(res?.status).toBe(404)
    expect(await res!.text()).toContain('baked 404')
    expect(res?.headers.get('content-type')).toContain('text/html')
  })

  it('falls through to the live render when the artefact is missing', async () => {
    await removeArtefactInPlace(uploadsDir, notFoundArtefactPath('default'))
    const db = await makePublishedDb(makeSnapshot(true))
    const res = await renderNotFoundResponse(db, new URL('http://localhost/nope'), uploadsDir)
    expect(res?.status).toBe(404)
    expect(await res!.text()).toContain('This page is missing')
  })
})
