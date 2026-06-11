import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbResult } from '../../../server/db'
import { handleServerRequest } from '../../../server/router'
import { resetForTests } from '../../../server/publish/renderCache'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import { makePage, makeSite } from '../publisher/helpers'
import { createFakeDb } from './dbTestFake'
import {
  prepareInactiveSlot,
  writeArtefact,
  swapSlot,
} from '../../../server/publish/staticArtefact'

type QueryHandler = (sql: string, params: unknown[]) => DbResult | undefined

function makeTemplateRouteFakeDb(handlers: QueryHandler[]) {
  return createFakeDb(async (rawSql, params): Promise<DbResult> => {
    const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase()
    for (const handler of handlers) {
      const result = handler(sql, params)
      if (result) return result
    }
    throw new Error(`Unhandled SQL: ${rawSql}`)
  })
}

function rowDate(value: string) {
  return new Date(value)
}

describe('CMS dynamic template routes', () => {
  // Each test serves a different snapshot fixture at the same publish version.
  // Reset the render cache + version-keyed snapshot memos so one test's
  // published site can't leak into the next (or in from another test file).
  beforeEach(() => {
    resetForTests()
  })

  it('renders a published data row through the highest priority page template', async () => {
    const page = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['title'] },
      title: {
        moduleId: 'base.text',
        props: { text: 'Static title', tag: 'h1' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    page.id = 'post-template'
    page.title = 'Post Template'
    page.slug = 'post-template'
    page.template = {
      enabled: true,
      target: { kind: 'postTypes', tableSlugs: ['posts'] },
      priority: 100,
    }
    const snapshot: PublishedPageSnapshot = {
      cmsSnapshotVersion: 1,
      pageRowId: page.id,
      site: makeSite({ pages: [page] }),
    }

    const db = makeTemplateRouteFakeDb([
      (sql) => {
        if (sql.startsWith('select id, name, version, enabled, lifecycle_status')) {
          return { rows: [], rowCount: 0 }
        }
        return undefined
      },
      (sql) => {
        // `collectFrontendInjections` reads elected media storage adapters so
        // their declared CSP origins extend the page CSP. No adapter is
        // elected in these tests, so the empty result lands the renderer on
        // the local-disk defaults.
        if (sql.includes('from active_media_storage_adapter')) {
          return { rows: [], rowCount: 0 }
        }
        return undefined
      },
      (sql, params) => {
        if (!sql.includes('site_snapshots.site_json')) return undefined

        // getPublishedPageBySlug — has data_rows.slug parameter; return empty
        // (no published page at 'posts/dynamic-post')
        if (sql.includes('data_rows.slug =')) {
          expect(params).toEqual(['posts/dynamic-post'])
          return { rows: [], rowCount: 0 }
        }

        // getLatestPublishedSiteSnapshot — return the snapshot so the template
        // renderer can find the matching template page
        return {
          rows: [{
            row_id: snapshot.pageRowId,
            site_json: snapshot.site,
            runtime_assets_json: null,
            importmap_body: null,
            importmap_sha256: null,
          }],
          rowCount: 1,
        }
      },
      (sql, params) => {
        if (!sql.startsWith('select data_row_versions.id')) return undefined
        expect(params).toEqual(['/posts', 'dynamic-post'])
        return {
          rows: [{
            id: 'version_1',
            row_id: 'row_1',
            table_id: 'posts',
            table_slug: 'posts',
            table_kind: 'postType',
            table_route_base: '/posts',
            version_number: 1,
            cells_json: {
              title: 'Dynamic Post',
              slug: 'dynamic-post',
              body: 'Body',
              featuredMedia: null,
              seoTitle: '',
              seoDescription: '',
            },
            slug: 'dynamic-post',
            published_at: rowDate('2026-05-01T10:00:00Z'),
            created_at: rowDate('2026-05-01T10:00:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    const res = await handleServerRequest(new Request('http://localhost/posts/dynamic-post'), { db })
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('<h1>Dynamic Post</h1>')
    expect(html).not.toContain('Static title')
  })

  it('serves a template route from disk when a baked artefact exists', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'template-disk-test-'))

    try {
      // Bake a pre-rendered artefact for the template route
      const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
      await writeArtefact(slotDir, '/posts/dynamic-post', '<html><body><h1>Baked template post</h1></body></html>')
      await swapSlot(uploadsDir, slot)

      // DB that would error if the snapshot path were consulted
      const db = createFakeDb(async (sql: string): Promise<DbResult> => {
        const s = sql.toLowerCase()
        if (s.includes('site_snapshots')) {
          throw new Error('Snapshot queried despite disk artefact hit')
        }
        if (s.includes('count(*) as count from site')) return { rows: [{ count: 1 }], rowCount: 1 }
        if (s.includes('from users') && s.includes('role_id')) return { rows: [{ count: 1 }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      })

      const res = await handleServerRequest(
        new Request('http://localhost/posts/dynamic-post'),
        { db, uploadsDir },
      )

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain('Baked template post')
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('falls through to the live renderer for a template route with a render-affecting (loop pagination) query', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'template-qs-test-'))

    try {
      // Bake an artefact — but the loop-pagination query affects the render so
      // it must be bypassed (junk queries instead serve the artefact — ISS-032)
      const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
      await writeArtefact(slotDir, '/posts/dynamic-post', '<html>baked</html>')
      await swapSlot(uploadsDir, slot)

      const page = makePage({
        root: { moduleId: 'base.body', props: {}, children: ['title'] },
        title: {
          moduleId: 'base.text',
          props: { text: 'Static title', tag: 'h1' },
          dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
        },
      })
      page.id = 'post-template-qs'
      page.title = 'Post Template QS'
      page.slug = 'post-template-qs'
      page.template = {
        enabled: true,
        target: { kind: 'postTypes', tableSlugs: ['posts'] },
        priority: 100,
      }
      const snapshot: PublishedPageSnapshot = {
        cmsSnapshotVersion: 1,
        pageRowId: page.id,
        site: makeSite({ pages: [page] }),
      }

      const db = makeTemplateRouteFakeDb([
        (sql) => {
          if (sql.startsWith('select id, name, version, enabled, lifecycle_status')) {
            return { rows: [], rowCount: 0 }
          }
          return undefined
        },
        (sql) => {
          if (sql.includes('from active_media_storage_adapter')) {
            return { rows: [], rowCount: 0 }
          }
          return undefined
        },
        (sql) => {
          if (!sql.includes('site_snapshots.site_json')) return undefined
          if (sql.includes('data_rows.slug =')) {
            return { rows: [], rowCount: 0 }
          }
          return {
            rows: [{
              row_id: snapshot.pageRowId,
              site_json: snapshot.site,
              runtime_assets_json: null,
              importmap_body: null,
              importmap_sha256: null,
            }],
            rowCount: 1,
          }
        },
        (sql, params) => {
          if (!sql.startsWith('select data_row_versions.id')) return undefined
          return {
            rows: [{
              id: 'version_qs',
              row_id: 'row_qs',
              table_id: 'posts',
              table_slug: 'posts',
              table_kind: 'postType',
              table_route_base: '/posts',
              version_number: 1,
              cells_json: {
                title: 'QS Post',
                slug: 'dynamic-post',
                body: 'Body',
                featuredMedia: null,
                seoTitle: '',
                seoDescription: '',
              },
              slug: 'dynamic-post',
              published_at: rowDate('2026-05-01T10:00:00Z'),
              created_at: rowDate('2026-05-01T10:00:00Z'),
            }],
            rowCount: 1,
          }
        },
      ])

      const res = await handleServerRequest(
        new Request('http://localhost/posts/dynamic-post?loop_x_page=2'),
        { db, uploadsDir },
      )

      // The live renderer was called (not the baked artefact) and rendered from DB
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      // Must NOT return the baked content (which just has "baked")
      const body = await res.text()
      expect(body).not.toContain('>baked<')
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('redirects an old published data row slug to the active published slug', async () => {
    const db = makeTemplateRouteFakeDb([
      (sql, params) => {
        if (!sql.includes('site_snapshots.site_json')) return undefined
        // getPublishedPageBySlug — return empty (no published page at this slug)
        if (sql.includes('data_rows.slug =')) {
          expect(params).toEqual(['posts/untitled'])
        }
        return { rows: [], rowCount: 0 }
      },
      (sql, params) => {
        if (!sql.startsWith('select data_row_versions.id')) return undefined
        expect(params).toEqual(['/posts', 'untitled'])
        return { rows: [], rowCount: 0 }
      },
      (sql, params) => {
        if (!sql.startsWith('select data_row_redirects.id')) return undefined
        expect(params).toEqual(['/posts', 'untitled'])
        return {
          rows: [{
            id: 'redirect_1',
            from_route_base: '/posts',
            from_slug: 'untitled',
            target_route_base: '/posts',
            target_slug: 'post',
          }],
          rowCount: 1,
        }
      },
    ])

    const res = await handleServerRequest(new Request('http://localhost/posts/untitled'), { db })

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/posts/post')
  })
})
