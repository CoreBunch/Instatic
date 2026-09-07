import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../server/db'
import { resetForTests } from '../../../server/publish/renderCache'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import {
  renderPublishedSnapshot,
  renderPublishedDataRowTemplate,
} from '../../../server/publish/publicRenderer'
import type { PublishedDataRow } from '@core/data/schemas'
import { handleServerRequest } from '../../../server/router'
import { cleanupPublishingTestDbs, createPublishingTestDb } from '../helpers/publishingTestDb'
import { createFakeDb } from './dbTestFake'
import { createUser } from '../../../server/repositories/users'
import { saveDraftSite } from '../../../server/repositories/site'
import { makeSite } from '../publisher/helpers'

afterEach(cleanupPublishingTestDbs)

function snapshot(text: string): PublishedPageSnapshot {
  return {
    cmsSnapshotVersion: 1,
    pageRowId: 'page_home',
    site: {
      id: 'project_1',
      name: 'Public Site',
      pages: [
        {
          id: 'page_home',
          title: 'Home',
          slug: 'index',
          rootNodeId: 'root',
          nodes: {
            root: {
              id: 'root',
              moduleId: 'base.body',
              props: {},
              breakpointOverrides: {},
              children: ['text_1'],
            },
            text_1: {
              id: 'text_1',
              moduleId: 'base.text',
              props: { text, tag: 'h1' },
              breakpointOverrides: {},
              children: [],
            },
          },
        },
      ],
      files: [],
      visualComponents: [],
      breakpoints: [
        { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
      ],
      settings: {
        metaTitle: 'Public Site',
        shortcuts: {},
      },
      styleRules: {},
      createdAt: 1000,
      updatedAt: 2000,
    },
  }
}

async function makePublishedDb(
  activeSnapshot: PublishedPageSnapshot | null,
  runtimeAssets: Record<string, unknown>[] = [],
): Promise<DbClient> {
  const db = await createPublishingTestDb(activeSnapshot?.site ?? null)
  if (!activeSnapshot) await saveDraftSite(db, makeSite())
  await createUser(db, { email: 'public-test@local.test', displayName: 'Local owner', passwordHash: 'unused-test-hash', roleId: 'owner', allowOwnerRole: true })
  if (!runtimeAssets.length) return db
  return createFakeDb(async (sql, params) => {
    if (sql.includes('select public_path, content_type, content_bytes')) {
      const row = runtimeAssets.find((asset) => asset.public_path === params[0])
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    return db.unsafe(sql, params)
  })
}

describe('public rendering', () => {
  // Each test serves a different snapshot/db at the same publish version, and
  // the public router now peeks the Layer B cache BEFORE resolving the route —
  // without a reset, one test's cached `/` render would be served to the next.
  beforeEach(() => {
    resetForTests()
  })

  it('renders complete HTML from a published snapshot', async () => {
    const snap = snapshot('Visible to public')
    const { html } = await renderPublishedSnapshot(snap, { db: await makePublishedDb(snap) })

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('Visible to public')
    expect(html).toContain('<title>Home</title>')
  })

  // Guards the page-wrapper's identity reporting after the shared
  // `renderMergedTemplate` extraction: pageId/slug come from the page row,
  // not the merged tree.
  it('reports pageId and slug from the page row for the snapshot path', async () => {
    const snap = snapshot('Identity')
    const out = await renderPublishedSnapshot(snap, { db: await makePublishedDb(snap) })
    expect(out.pageId).toBe('page_home')
    expect(out.slug).toBe('index')
    expect(out.siteId).toBe('project_1')
  })

  // Guards the data-row-wrapper's unique early-return branch: no entry template
  // in the chain → null (404 upstream). This branch is the only behaviour that
  // differs from the shared render tail.
  it('returns null from the data-row-template path when no entry template exists', async () => {
    const snap = snapshot('No template')
    const row: PublishedDataRow = {
      id: 'ver_1',
      rowId: 'row_1',
      tableId: 'tbl_posts',
      tableSlug: 'posts',
      tableKind: 'posts',
      tableRouteBase: '/blog',
      versionNumber: 1,
      cells: { title: 'Hello' },
      slug: 'hello',
      featuredMediaId: null,
      featuredMediaPath: null,
      authorUserId: null,
      authorName: null,
      authorRoleSlug: null,
      authorRoleName: null,
      publishedByUserId: null,
      publishedByName: null,
      publishedByRoleSlug: null,
      publishedByRoleName: null,
      publishedAt: '2024-01-01T00:00:00.000Z',
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const result = await renderPublishedDataRowTemplate(snap, row, { db: await makePublishedDb(snap) })
    expect(result).toBeNull()
  })

  const entrySnapshotWithSettings = (
    settings: PublishedPageSnapshot['site']['settings'],
  ): PublishedPageSnapshot => ({
      cmsSnapshotVersion: 1,
      pageRowId: 'page_home',
      site: {
        id: 'project_1',
        name: 'Public Site',
        pages: [
          {
            id: 'entry_template',
            title: 'Entry Template',
            slug: 'entry-template',
            rootNodeId: 'root',
            template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 },
            nodes: {
              root: {
                id: 'root',
                moduleId: 'base.body',
                props: {},
                breakpointOverrides: {},
                children: ['heading', 'crumb'],
              },
              heading: {
                id: 'heading',
                moduleId: 'base.text',
                props: { text: '{currentEntry.title}', tag: 'h1' },
                breakpointOverrides: {},
                children: [],
              },
              crumb: {
                id: 'crumb',
                moduleId: 'base.text',
                props: { text: 'Breadcrumb: {page.title}', tag: 'p' },
                breakpointOverrides: {},
                children: [],
              },
            },
          } as unknown as PublishedPageSnapshot['site']['pages'][number],
        ],
        files: [],
        visualComponents: [],
        breakpoints: [
          { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
        ],
        settings,
        styleRules: {},
        createdAt: 1000,
        updatedAt: 2000,
      },
    })

  const entryBaseRow: Omit<PublishedDataRow, 'cells'> = {
    id: 'ver_1',
    rowId: 'row_1',
    tableId: 'tbl_posts',
    tableSlug: 'posts',
    tableKind: 'posts',
    tableRouteBase: '/blog',
    versionNumber: 1,
    slug: 'hello',
    featuredMediaId: null,
    featuredMediaPath: null,
    authorUserId: null,
    authorName: null,
    authorRoleSlug: null,
    authorRoleName: null,
    publishedByUserId: null,
    publishedByName: null,
    publishedByRoleSlug: null,
    publishedByRoleName: null,
    publishedAt: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
  }

  // Guards the split between the entry's SEO `<head>` overrides and its real
  // title: `seoTitle` / `seoDescription` drive `<title>` and
  // `<meta name="description">`, while both on-page title bindings
  // (`{currentEntry.title}` and `{page.title}`) keep rendering the plain
  // title. `page.title` feeds the binding frame as well as the meta tag, so
  // writing the SEO override onto it would leak into visible page content.
  it('routes seoTitle/seoDescription into <head> without touching the on-page title bindings', async () => {
    const snap = entrySnapshotWithSettings({ shortcuts: {} })

    const withSeo = await renderPublishedDataRowTemplate(
      snap,
      {
        ...entryBaseRow,
        cells: {
          title: 'Plain H1 Title',
          seoTitle: 'SEO Override Title',
          seoDescription: 'SEO override description',
        },
      },
      { db: await makePublishedDb(snap) },
    )
    expect(withSeo?.html).toContain('<title>SEO Override Title</title>')
    expect(withSeo?.html).toContain(
      '<meta name="description" content="SEO override description">',
    )
    expect(withSeo?.html).toContain('<h1>Plain H1 Title</h1>')
    expect(withSeo?.html).toContain('<p>Breadcrumb: Plain H1 Title</p>')
    expect(withSeo?.html).not.toContain('Breadcrumb: SEO Override Title')

    resetForTests()

    // No SEO cells → byte-identical to the pre-SEO behaviour: entry title in
    // `<title>`, no description tag at all.
    const withoutSeo = await renderPublishedDataRowTemplate(
      snap,
      { ...entryBaseRow, cells: { title: 'Plain H1 Title' } },
      { db: await makePublishedDb(snap) },
    )
    expect(withoutSeo?.html).toContain('<title>Plain H1 Title</title>')
    expect(withoutSeo?.html).not.toContain('<meta name="description"')

    resetForTests()

    // A blank SEO cell is not an override — it falls through to the site
    // settings exactly as an absent one does.
    const blankSeo = await renderPublishedDataRowTemplate(
      snap,
      { ...entryBaseRow, cells: { title: 'Plain H1 Title', seoTitle: '   ', seoDescription: '' } },
      { db: await makePublishedDb(snap) },
    )
    expect(blankSeo?.html).toContain('<title>Plain H1 Title</title>')
    expect(blankSeo?.html).not.toContain('<meta name="description"')
  })

  // A site-wide Meta Title (Settings → General) applies to every page. An
  // entry's own authored SEO fields are more specific, so they win.
  it('lets an entry SEO override outrank the site-level metaTitle/metaDescription', async () => {
    const snap = entrySnapshotWithSettings({
      metaTitle: 'Site Wide Meta Title',
      metaDescription: 'Site wide description',
      shortcuts: {},
    })

    const withSeo = await renderPublishedDataRowTemplate(
      snap,
      {
        ...entryBaseRow,
        cells: {
          title: 'Plain H1 Title',
          seoTitle: 'SEO Override Title',
          seoDescription: 'SEO override description',
        },
      },
      { db: await makePublishedDb(snap) },
    )
    expect(withSeo?.html).toContain('<title>SEO Override Title</title>')
    expect(withSeo?.html).toContain(
      '<meta name="description" content="SEO override description">',
    )

    resetForTests()

    // Without an SEO title override the localized entry title is preferred;
    // the site description remains the fallback.
    const withoutSeo = await renderPublishedDataRowTemplate(
      snap,
      { ...entryBaseRow, cells: { title: 'Plain H1 Title' } },
      { db: await makePublishedDb(snap) },
    )
    expect(withoutSeo?.html).toContain('<title>Plain H1 Title</title>')
    expect(withoutSeo?.html).toContain(
      '<meta name="description" content="Site wide description">',
    )
  })

  it('injects stored runtime asset manifests when rendering a published snapshot', async () => {
    const published = snapshot('Runtime page')
    published.runtimeAssets = {
      scripts: [
        {
          fileId: 'entry',
          src: '/_instatic/assets/version_1/entries/entry.js',
          placement: 'body-end',
          timing: 'dom-ready',
          priority: 10,
        },
      ],
    }

    const { html } = await renderPublishedSnapshot(published, { db: await makePublishedDb(published) })

    expect(html).toContain("script-src 'self'")
    expect(html).toContain('/_instatic/assets/version_1/entries/entry.js')
  })

  it('serves / from the active published index snapshot', async () => {
    const res = await handleServerRequest(new Request('http://localhost/'), {
      db: await makePublishedDb(snapshot('Homepage')),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Homepage')
  })

  it('serves immutable published runtime assets by public path', async () => {
    const res = await handleServerRequest(new Request('http://localhost/_instatic/assets/version_1/entries/entry.js'), {
      db: await makePublishedDb(null, [
        {
          public_path: '/_instatic/assets/version_1/entries/entry.js',
          content_type: 'text/javascript; charset=utf-8',
          content_bytes: new TextEncoder().encode('console.log("runtime")'),
        },
      ]),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toContain('immutable')
    // Hardening: no scripting context, no MIME sniffing (GHSA-5h25).
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe('console.log("runtime")')
  })

  // GHSA-5h25: this namespace served SVG (active content) from the CMS origin
  // with no CSP. It now serves only the asset kinds the publisher emits and
  // refuses everything else, even a file that is present.
  it('refuses to serve an SVG from the runtime-asset namespace', async () => {
    const res = await handleServerRequest(new Request('http://localhost/_instatic/assets/version_1/poc.svg'), {
      db: await makePublishedDb(null, [
        {
          public_path: '/_instatic/assets/version_1/poc.svg',
          content_type: 'image/svg+xml',
          content_bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        },
      ]),
    })

    expect(res.status).toBe(404)
  })

  it('returns 404 when there is no active published snapshot', async () => {
    const res = await handleServerRequest(new Request('http://localhost/'), {
      db: await makePublishedDb(null),
    })

    expect(res.status).toBe(404)
  })

  it('emits external CSS <link> tags pointing at the per-site bundle', async () => {
    const snap = snapshot('Hello')
    const { html } = await renderPublishedSnapshot(snap, { db: await makePublishedDb(snap) })
    expect(html).toMatch(/<link rel="stylesheet" href="\/_instatic\/css\/reset-[a-f0-9]{12}\.css">/)
    // No inline reset block — site-wide CSS lives in the external bundle.
    expect(html).not.toContain(':where(*, *::before, *::after)')
  })

  it('serves the reset bundle file from /_instatic/css/<filename> with immutable cache', async () => {
    const published = snapshot('Hello')
    // First request the page to discover the current bundle filenames.
    const pageRes = await handleServerRequest(new Request('http://localhost/'), {
      db: await makePublishedDb(published),
    })
    const pageHtml = await pageRes.text()
    const resetMatch = pageHtml.match(/href="(\/_instatic\/css\/reset-[a-f0-9]{12}\.css)"/)
    expect(resetMatch).not.toBeNull()

    // Now fetch the bundle.
    const cssRes = await handleServerRequest(
      new Request(`http://localhost${resetMatch![1]}`),
      { db: await makePublishedDb(published) },
    )
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('content-type')).toContain('text/css')
    expect(cssRes.headers.get('cache-control')).toContain('immutable')
    expect(cssRes.headers.get('cache-control')).toContain('max-age=31536000')
    const cssBody = await cssRes.text()
    expect(cssBody).toContain(':where(*, *::before, *::after) { box-sizing: border-box; }')
  })

  it('returns 404 for stale CSS hashes so cached HTML refetches the page', async () => {
    const cssRes = await handleServerRequest(
      new Request('http://localhost/_instatic/css/reset-deadbeefdead.css'),
      { db: await makePublishedDb(snapshot('Hello')) },
    )
    expect(cssRes.status).toBe(404)
  })

  it('returns 404 for malformed CSS bundle paths', async () => {
    const cssRes = await handleServerRequest(
      new Request('http://localhost/_instatic/css/whatever.css'),
      { db: await makePublishedDb(snapshot('Hello')) },
    )
    expect(cssRes.status).toBe(404)
  })
})
