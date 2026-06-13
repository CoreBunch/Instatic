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
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbClient, DbResult } from '../../../server/db'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import { renderNotFoundResponse } from '../../../server/publish/publicRouter'
import { getStats, resetForTests } from '../../../server/publish/renderCache'

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

/**
 * Minimal DbClient for the live-render path: `getLatestPublishedSiteSnapshot`
 * (distinguished by its `order by data_rows.created_at` clause) returns the
 * fixture snapshot; everything else is empty.
 */
function makeFakeDb(snapshot: PublishedPageSnapshot | null): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    void values
    const sql = strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase()
    if (sql.includes('site_snapshots.site_json') && sql.includes('order by data_rows.created_at')) {
      return {
        rows: snapshot
          ? [{
              row_id: snapshot.pageRowId,
              site_json: snapshot.site,
              runtime_assets_json: snapshot.runtimeAssets ?? null,
              importmap_body: null,
              importmap_sha256: null,
            } as unknown as Row]
          : [],
        rowCount: snapshot ? 1 : 0,
      }
    }
    return { rows: [], rowCount: 0 }
  }
  handle.unsafe = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    _sql: string,
    _params?: unknown[],
  ): Promise<DbResult<Row>> => ({ rows: [], rowCount: 0 })
  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)
  return handle as DbClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetForTests()
})

describe('renderNotFoundResponse — Layer B live render', () => {
  it('renders the notFound template with status 404 and caches it', async () => {
    const db = makeFakeDb(makeSnapshot(true))

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
    const db = makeFakeDb(makeSnapshot(false))
    expect(await renderNotFoundResponse(db, new URL('http://localhost/nowhere'))).toBeNull()
    expect(getStats()).toMatchObject({ hits: 0, misses: 0, size: 0 })
  })

  it('returns null when nothing is published at all', async () => {
    const db = makeFakeDb(null)
    expect(await renderNotFoundResponse(db, new URL('http://localhost/nowhere'))).toBeNull()
  })
})

describe('renderNotFoundResponse — Layer A baked artefact', () => {
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-404-'))
    const slotDir = join(uploadsDir, 'published', 'a')
    await mkdir(slotDir, { recursive: true })
    await writeFile(join(slotDir, '404.html'), '<!DOCTYPE html><h1>baked 404</h1>', 'utf-8')
    await symlink('a', join(uploadsDir, 'published', 'current'))
  })

  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('serves the baked 404.html with status 404 without touching the DB', async () => {
    // A DB that throws on ANY query proves the artefact path is DB-free.
    const explodingDb = (async () => {
      throw new Error('DB must not be queried on the Layer A path')
    }) as unknown as DbClient

    const res = await renderNotFoundResponse(explodingDb, new URL('http://localhost/nope'), uploadsDir)
    expect(res?.status).toBe(404)
    expect(await res!.text()).toContain('baked 404')
    expect(res?.headers.get('content-type')).toContain('text/html')
  })

  it('falls through to the live render when the artefact is missing', async () => {
    await rm(join(uploadsDir, 'published', 'a', '404.html'))
    const db = makeFakeDb(makeSnapshot(true))
    const res = await renderNotFoundResponse(db, new URL('http://localhost/nope'), uploadsDir)
    expect(res?.status).toBe(404)
    expect(await res!.text()).toContain('This page is missing')
  })
})
