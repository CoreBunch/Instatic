import { afterEach, describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import {
  buildRobotsTxt,
  buildSitemapXml,
  collectSitemapEntries,
  handleSitemapRequest,
  pageSlugToPath,
  type SitemapEntry,
} from '../../../server/publish/sitemap'
import {
  canonicalPublicOrigin,
  configurePublicOrigins,
  resetPublicOrigins,
} from '../../../server/auth/security'
import type { DbClient } from '../../../server/db/client'

describe('pageSlugToPath', () => {
  it('maps the canonical index slug to the site root', () => {
    expect(pageSlugToPath('index')).toBe('/')
    expect(pageSlugToPath('')).toBe('/')
  })

  it('prefixes other slugs with a single slash and strips stray ones', () => {
    expect(pageSlugToPath('about')).toBe('/about')
    expect(pageSlugToPath('/about/')).toBe('/about')
    expect(pageSlugToPath('blog/post')).toBe('/blog/post')
  })
})

describe('buildSitemapXml', () => {
  it('emits a urlset with absolute locs and lastmod', () => {
    const entries: SitemapEntry[] = [
      { path: '/', lastmod: '2026-07-19T10:00:00.000Z' },
      { path: '/about', lastmod: '2026-07-18T09:00:00.000Z' },
    ]
    const xml = buildSitemapXml('https://example.com', entries)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')
    expect(xml).toContain('<loc>https://example.com/</loc>')
    expect(xml).toContain('<loc>https://example.com/about</loc>')
    expect(xml).toContain('<lastmod>2026-07-19T10:00:00.000Z</lastmod>')
  })

  it('xml-escapes special characters in the loc', () => {
    const xml = buildSitemapXml('https://example.com', [
      { path: '/a&b<c>', lastmod: '2026-01-01T00:00:00.000Z' },
    ])
    expect(xml).toContain('<loc>https://example.com/a&amp;b&lt;c&gt;</loc>')
    expect(xml).not.toContain('/a&b<c>')
  })
})

describe('buildRobotsTxt', () => {
  it('allows all except /admin and advertises the sitemap', () => {
    const txt = buildRobotsTxt('https://example.com')
    expect(txt).toContain('User-agent: *')
    expect(txt).toContain('Disallow: /admin')
    expect(txt).toContain('Sitemap: https://example.com/sitemap.xml')
  })
})

describe('canonicalPublicOrigin', () => {
  afterEach(() => {
    resetPublicOrigins()
  })

  it('upgrades a host-matched request to its configured origin (https behind a TLS edge)', () => {
    configurePublicOrigins(['https://app.example.com', 'https://www.example.com'])
    // The edge terminates TLS; the container sees plain http.
    expect(canonicalPublicOrigin(new URL('http://www.example.com/sitemap.xml'))).toBe(
      'https://www.example.com',
    )
  })

  it('falls back to the canonical first entry when no host matches', () => {
    configurePublicOrigins(['https://www.example.com', 'https://app.example.com'])
    expect(canonicalPublicOrigin(new URL('http://internal:8080/sitemap.xml'))).toBe(
      'https://www.example.com',
    )
  })

  it('uses the request origin when nothing is configured', () => {
    expect(canonicalPublicOrigin(new URL('http://localhost:3001/sitemap.xml'))).toBe(
      'http://localhost:3001',
    )
  })
})

describe('handleSitemapRequest origin anchoring', () => {
  afterEach(() => {
    resetPublicOrigins()
  })

  it('anchors robots.txt to the canonical public origin, not the request scheme', async () => {
    configurePublicOrigins(['https://www.example.com'])
    // robots.txt path never touches the db — a bare sentinel suffices.
    const db = {} as DbClient
    const url = new URL('http://www.example.com/robots.txt')
    const res = await handleSitemapRequest(new Request(url), url, { db })
    expect(res).not.toBeNull()
    expect(await res!.text()).toContain('Sitemap: https://www.example.com/sitemap.xml')
  })
})

describe('collectSitemapEntries', () => {
  it('enumerates published pages + row routes, excluding templates/drafts/deleted', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      // One published snapshot flags `p-tmpl` as a template page.
      await db`
        insert into site_snapshots (id, site_json, content_hash)
        values (${'s1'}, ${{
          pages: [
            { id: 'p-index', slug: 'index' },
            { id: 'p-about', slug: 'about' },
            { id: 'p-tmpl', slug: 'post-template', template: { enabled: true } },
          ],
        }}, ${'hash'})`

      async function seedPage(
        id: string,
        slug: string,
        status: string,
        opts: { deleted?: boolean; createdAt: string; updatedAt: string },
      ): Promise<void> {
        // data_rows.active_version_id ↔ data_row_versions.row_id are mutually
        // FK-referencing, so seed the row first (null version), then the
        // version, then link them — mirrors the real publish write order.
        const versionId = `v-${id}`
        await db`
          insert into data_rows (id, table_id, slug, status, created_at, updated_at, deleted_at)
          values (${id}, ${'pages'}, ${slug}, ${status}, ${opts.createdAt}, ${opts.updatedAt}, ${opts.deleted ? '2026-07-19T00:00:00.000Z' : null})`
        await db`
          insert into data_row_versions (id, row_id, version_number, slug, site_snapshot_id)
          values (${versionId}, ${id}, ${1}, ${slug}, ${'s1'})`
        await db`update data_rows set active_version_id = ${versionId} where id = ${id}`
      }

      await seedPage('p-index', 'index', 'published', {
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-19T10:00:00.000Z',
      })
      await seedPage('p-about', 'about', 'published', {
        createdAt: '2026-07-02T00:00:00.000Z',
        updatedAt: '2026-07-18T09:00:00.000Z',
      })
      await seedPage('p-tmpl', 'post-template', 'published', {
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
      })
      await seedPage('p-draft', 'secret', 'draft', {
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-16T00:00:00.000Z',
      })
      await seedPage('p-del', 'gone', 'published', {
        deleted: true,
        createdAt: '2026-07-05T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      })

      // A content table with a route base + one published row.
      await db`
        insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label)
        values (${'blog'}, ${'Blog'}, ${'blog'}, ${'postType'}, ${'/blog'}, ${'Post'}, ${'Posts'})`
      await db`
        insert into data_rows (id, table_id, slug, status, created_at, updated_at)
        values (${'r1'}, ${'blog'}, ${'hello-draft-slug'}, ${'published'}, ${'2026-07-06T00:00:00.000Z'}, ${'2026-07-14T00:00:00.000Z'})`
      await db`
        insert into data_row_versions (id, row_id, version_number, slug, site_snapshot_id)
        values (${'vr1'}, ${'r1'}, ${1}, ${'hello-world'}, ${'s1'})`
      await db`update data_rows set active_version_id = ${'vr1'} where id = ${'r1'}`

      const entries = await collectSitemapEntries(db)
      const byPath = new Map(entries.map((e) => [e.path, e.lastmod]))

      expect(new Set(byPath.keys())).toEqual(new Set(['/', '/about', '/blog/hello-world']))
      // Page lastmod is the row's updated_at.
      expect(byPath.get('/')).toBe('2026-07-19T10:00:00.000Z')
      expect(byPath.get('/about')).toBe('2026-07-18T09:00:00.000Z')
      // Row route uses the published version's slug, not the draft data_rows.slug.
      expect(byPath.get('/blog/hello-world')).toBe('2026-07-14T00:00:00.000Z')
    } finally {
      await cleanup()
    }
  })
})
