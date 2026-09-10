/**
 * Integration tests for Layer B caching in publicRouter.ts.
 *
 * Verifies that `renderPublicResolution` correctly uses the render cache:
 *   - First request renders and caches.
 *   - Second identical request is served from cache (no re-render).
 *   - After `bumpPublishVersion()`, the next request re-renders.
 *   - Redirect resolutions are NOT cached.
 *   - Not-found resolutions are NOT cached.
 *
 * Uses `getStats()` from renderCache to observe hit/miss counts without
 * requiring module-level spying on the renderer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanupPublishingTestDbs, createPublishingTestDb, seedPublishingPage } from '../helpers/publishingTestDb'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { savePublishedRedirect } from '../../../server/repositories/data/publish'
afterEach(cleanupPublishingTestDbs)
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import { renderPublicResolution } from '../../../server/publish/publicRouter'
import { getStats, resetForTests } from '../../../server/publish/renderCache'
import { bumpPublishVersion } from '../../../server/publish/publishState'

// ---------------------------------------------------------------------------
// Minimal snapshot fixture
// ---------------------------------------------------------------------------

function makeSnapshot(): PublishedPageSnapshot {
  return {
    cmsSnapshotVersion: 1,
    pageRowId: 'page_test',
    site: {
      id: 'site_1',
      name: 'Test Site',
      pages: [
        {
          id: 'page_test',
          title: 'Test Page',
          slug: 'test',
          rootNodeId: 'root',
          nodes: {
            root: {
              id: 'root',
              moduleId: 'base.body',
              props: {},
              breakpointOverrides: {},
              children: [],
            },
          },
        },
      ],
      files: [],
      visualComponents: [],
      breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
      settings: { metaTitle: 'Test Site', shortcuts: {} },
      styleRules: {},
      createdAt: 1000,
      updatedAt: 2000,
    },
  }
}

async function makePublishedDb(snapshot: PublishedPageSnapshot | null) {
  return createPublishingTestDb(snapshot?.site ?? null)
}

async function makeRedirectDb() {
  const site = makeSnapshot().site
  site.pages[0].slug = 'posts/new-post'
  const db = await createPublishingTestDb(site)
  await savePublishedRedirect(db, site.pages[0].id, 'pages', 'default', '/posts/old-post')
  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetForTests()
})

describe('Layer B render cache integration', () => {
  it('first request is a miss; second identical request is a cache hit', async () => {
    const snap = makeSnapshot()
    const db = await makePublishedDb(snap)
    const url = new URL('http://localhost/test')

    const res1 = await renderPublicResolution(db, url)
    expect(res1?.status).toBe(200)
    expect(getStats()).toMatchObject({ hits: 0, misses: 1, size: 1 })

    const res2 = await renderPublicResolution(db, url)
    expect(res2?.status).toBe(200)
    expect(getStats()).toMatchObject({ hits: 1, misses: 1, size: 1 })
  })

  it('responses from cache and from renderer have the same body', async () => {
    const snap = makeSnapshot()
    const db = await makePublishedDb(snap)
    const url = new URL('http://localhost/test')

    const res1 = await renderPublicResolution(db, url)
    const body1 = await res1!.text()

    const res2 = await renderPublicResolution(db, url)
    const body2 = await res2!.text()

    expect(body1).toBe(body2)
    expect(body1).toContain('<!DOCTYPE html>')
  })

  it('bumpPublishVersion causes the next request to re-render', async () => {
    const snap = makeSnapshot()
    const db = await makePublishedDb(snap)
    const url = new URL('http://localhost/test')

    await renderPublicResolution(db, url)
    expect(getStats()).toMatchObject({ hits: 0, misses: 1 })

    bumpPublishVersion()

    await renderPublicResolution(db, url)
    expect(getStats()).toMatchObject({ hits: 0, misses: 2 })
  })

  it('after re-render following a bump, the subsequent request is a hit', async () => {
    const snap = makeSnapshot()
    const db = await makePublishedDb(snap)
    const url = new URL('http://localhost/test')

    await renderPublicResolution(db, url)
    bumpPublishVersion()
    await renderPublicResolution(db, url) // re-render after bump
    await renderPublicResolution(db, url) // should be a hit
    expect(getStats()).toMatchObject({ hits: 1, misses: 2 })
  })

  it('different URL paths are distinct cache entries', async () => {
    const snap = makeSnapshot()
    const db = await makePublishedDb(snap)

    await seedPublishingPage(db, { ...snap.site.pages[0], id: 'other-page', slug: 'other' })
    await publishDraftSite(db, null, undefined, { variants: [{ rowId: 'other-page', localeId: 'default' }] })
    await renderPublicResolution(db, new URL('http://localhost/test'))
    await renderPublicResolution(db, new URL('http://localhost/other'))
    expect(getStats().size).toBe(2)
    expect(getStats().misses).toBe(2)
  })

  it('same path with different render-affecting (loop pagination) queries are distinct entries', async () => {
    const snap = makeSnapshot()
    const db = await makePublishedDb(snap)

    // Only loop-pagination params survive query canonicalisation, so they are
    // the only thing that produces distinct cache keys (ISS-032). Junk params
    // would instead collapse onto one key.
    await renderPublicResolution(db, new URL('http://localhost/test?loop_x_page=1'))
    await renderPublicResolution(db, new URL('http://localhost/test?loop_x_page=2'))
    expect(getStats().size).toBe(2)
    expect(getStats().misses).toBe(2)
  })

  it('different junk query strings collapse onto a single cache entry', async () => {
    const snap = makeSnapshot()
    const db = await makePublishedDb(snap)

    await renderPublicResolution(db, new URL('http://localhost/test?utm=a'))
    await renderPublicResolution(db, new URL('http://localhost/test?utm=b'))
    expect(getStats().size).toBe(1)
    expect(getStats().misses).toBe(1)
  })

  it('redirect resolutions are NOT cached', async () => {
    const db = await makeRedirectDb()
    // Redirect URL: /posts/old-post → resolved by getDataRowRedirectByRoute
    const url = new URL('http://localhost/posts/old-post')

    const res1 = await renderPublicResolution(db, url)
    expect(res1?.status).toBe(301)
    // Cache should be untouched — redirects bypass getOrRender.
    expect(getStats()).toMatchObject({ hits: 0, misses: 0, size: 0 })

    const res2 = await renderPublicResolution(db, url)
    expect(res2?.status).toBe(301)
    expect(getStats()).toMatchObject({ hits: 0, misses: 0, size: 0 })
  })

  it('not-found resolutions are NOT cached', async () => {
    const db = await makePublishedDb(null) // no snapshot → not-found
    const url = new URL('http://localhost/nowhere')

    const res1 = await renderPublicResolution(db, url)
    expect(res1).toBeNull()
    expect(getStats()).toMatchObject({ hits: 0, misses: 0, size: 0 })

    const res2 = await renderPublicResolution(db, url)
    expect(res2).toBeNull()
    expect(getStats()).toMatchObject({ hits: 0, misses: 0, size: 0 })
  })
})
