/**
 * First-party robots.txt + sitemap.xml endpoint tests.
 *
 * Uses a fake DbClient that serves a published snapshot (pages incl. a
 * template page and a noindex page) plus published rows for the sitemap
 * query. Verifies content types, AI-crawler toggles, noindex/template
 * exclusion, publishVersion-keyed caching, and the request-origin fallback.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/db'
import {
  serveRobotsTxt,
  serveSitemapXml,
  resetSeoEndpointCachesForTests,
} from '../../../server/publish/seoEndpoints'
import { bumpPublishVersion } from '../../../server/publish/publishState'
import { configurePublicOrigins, resetPublicOrigins } from '../../../server/auth/security'
import type { SiteSeoSettings } from '@core/seo'

function makeSiteJson(seo: SiteSeoSettings | undefined) {
  return {
    id: 'site_1',
    name: 'Test Site',
    pages: [
      {
        id: 'page_home',
        title: 'Home',
        slug: 'index',
        rootNodeId: 'root',
        nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, children: [] } },
      },
      {
        id: 'page_about',
        title: 'About',
        slug: 'about',
        rootNodeId: 'root',
        nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, children: [] } },
      },
      {
        id: 'page_secret',
        title: 'Secret',
        slug: 'secret',
        rootNodeId: 'root',
        nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, children: [] } },
        seo: { noindex: true },
      },
      {
        id: 'page_template',
        title: 'Post template',
        slug: 'post-template',
        rootNodeId: 'root',
        nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, children: [] } },
        template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 },
      },
    ],
    files: [],
    visualComponents: [],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { shortcuts: {}, ...(seo ? { seo } : {}) },
    styleRules: {},
    createdAt: 1000,
    updatedAt: 2000,
  }
}

interface FakeRow {
  row_id: string
  row_slug: string
  table_route_base: string
  cells_json: Record<string, unknown>
  published_at: string
}

function makeFakeDb(seo: SiteSeoSettings | undefined, sitemapRows: FakeRow[]): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase()

    // getLatestSnapshotForVersion — site_snapshots lookup
    if (sql.includes('site_snapshots')) {
      return {
        rows: [{
          row_id: 'page_home',
          site_json: makeSiteJson(seo),
          runtime_assets_json: null,
          importmap_body: null,
          importmap_sha256: null,
        } as unknown as Row],
        rowCount: 1,
      }
    }

    // listPublishedRowsForSitemap
    if (sql.includes('data_row_versions.published_at')) {
      return { rows: sitemapRows as unknown as Row[], rowCount: sitemapRows.length }
    }

    return { rows: [], rowCount: 0 }
  }
  return handle as unknown as DbClient
}

const URL_NO_ORIGIN = new URL('http://localhost:3001/robots.txt')
// No public origin configured in these tests ⇒ requestHostIsCanonical → null
// ⇒ env protection is inert, so this request never changes the output.
const REQ = new Request('http://localhost:3001/robots.txt')

beforeEach(() => {
  resetSeoEndpointCachesForTests()
  // Each test regenerates against a fresh publish version — the snapshot
  // memo is version-keyed (createVersionedSingleFlight), so bumping makes
  // every cached body and snapshot of the previous test a miss.
  bumpPublishVersion()
})

describe('GET /robots.txt', () => {
  it('serves text/plain with default allow + sitemap line', async () => {
    const res = await serveRobotsTxt(makeFakeDb(undefined, []), URL_NO_ORIGIN, REQ)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const body = await res.text()
    expect(body).toContain('User-agent: *\nAllow: /')
    expect(body).toContain('Sitemap: http://localhost:3001/sitemap.xml')
    expect(body).not.toContain('<')
  })

  it('serves the stored body verbatim and appends the sitemap', async () => {
    const db = makeFakeDb({ robots: { content: 'User-agent: GPTBot\nDisallow: /' } }, [])
    const body = await (await serveRobotsTxt(db, URL_NO_ORIGIN, REQ)).text()
    expect(body).toContain('User-agent: GPTBot\nDisallow: /')
    expect(body).toContain('Sitemap: http://localhost:3001/sitemap.xml')
  })

  it('caches per publish version', async () => {
    const db = makeFakeDb(undefined, [])
    const first = await (await serveRobotsTxt(db, URL_NO_ORIGIN, REQ)).text()
    // Same version: served from cache even if settings change underneath.
    const dbChanged = makeFakeDb({ robots: { content: 'User-agent: *\nDisallow: /' } }, [])
    const second = await (await serveRobotsTxt(dbChanged, URL_NO_ORIGIN, REQ)).text()
    expect(second).toBe(first)
    // New publish version: regenerated.
    bumpPublishVersion()
    const third = await (await serveRobotsTxt(dbChanged, URL_NO_ORIGIN, REQ)).text()
    expect(third).toContain('Disallow: /')
  })

  it('serves a blanket Disallow on a non-canonical host (preview protection)', async () => {
    configurePublicOrigins(['https://acme.com'])
    try {
      const db = makeFakeDb(undefined, [])
      // Request arriving on a preview host that is NOT the configured origin.
      const previewReq = new Request('https://preview-abc.vercel.app/robots.txt', {
        headers: { host: 'preview-abc.vercel.app' },
      })
      const res = await serveRobotsTxt(db, new URL('https://preview-abc.vercel.app/robots.txt'), previewReq)
      const body = await res.text()
      expect(body).toBe('User-agent: *\nDisallow: /\n')
      expect(res.headers.get('x-robots-tag')).toBe('noindex')

      // The canonical host still serves the normal allow body.
      const canonReq = new Request('https://acme.com/robots.txt', { headers: { host: 'acme.com' } })
      const canon = await (await serveRobotsTxt(db, new URL('https://acme.com/robots.txt'), canonReq)).text()
      expect(canon).toContain('User-agent: *\nAllow: /')
    } finally {
      resetPublicOrigins()
    }
  })
})

describe('GET /sitemap.xml', () => {
  const rows: FakeRow[] = [
    {
      row_id: 'row_1',
      row_slug: 'hello',
      table_route_base: '/posts',
      cells_json: { title: 'Hello' },
      published_at: '2026-06-01T00:00:00.000Z',
    },
    {
      row_id: 'row_2',
      row_slug: 'hidden',
      table_route_base: '/posts',
      cells_json: { title: 'Hidden', seo: { noindex: true } },
      published_at: '2026-06-01T00:00:00.000Z',
    },
  ]

  it('serves application/xml with pages and rows, excluding noindex + templates', async () => {
    const res = await serveSitemapXml(makeFakeDb(undefined, rows), URL_NO_ORIGIN)
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8')
    const body = await res.text()
    expect(body).toContain('<loc>http://localhost:3001/</loc>')
    expect(body).toContain('<loc>http://localhost:3001/about</loc>')
    expect(body).toContain('<loc>http://localhost:3001/posts/hello</loc>')
    expect(body).toContain('<lastmod>2026-06-01T00:00:00.000Z</lastmod>')
    expect(body).not.toContain('/secret')
    expect(body).not.toContain('post-template')
    expect(body).not.toContain('/posts/hidden')
  })

  it('honours excludedTargets', async () => {
    const db = makeFakeDb({ sitemap: { excludedTargets: ['page:page_about', 'row:row_1'] } }, rows)
    const body = await (await serveSitemapXml(db, URL_NO_ORIGIN)).text()
    expect(body).not.toContain('/about')
    expect(body).not.toContain('/posts/hello')
    expect(body).toContain('<loc>http://localhost:3001/</loc>')
  })

  it('returns 404 when sitemap generation is disabled', async () => {
    const db = makeFakeDb({ sitemap: { enabled: false } }, rows)
    const res = await serveSitemapXml(db, URL_NO_ORIGIN)
    expect(res.status).toBe(404)
  })
})
