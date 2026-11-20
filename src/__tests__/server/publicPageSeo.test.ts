/**
 * Page head settings through the real public render path: the template chain
 * composer must carry the page's own settings past an everywhere layout, and
 * entry routes use the matched post-type template's settings as a pattern.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/db'
import { resetForTests } from '../../../server/publish/renderCache'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import { renderPublishedDataRowTemplate, renderPublishedSnapshot } from '../../../server/publish/publicRenderer'
import type { PublishedDataRow } from '@core/data/schemas'

type SnapshotPage = PublishedPageSnapshot['site']['pages'][number]

function node(id: string, moduleId: string, props: Record<string, unknown>, children: string[] = []) {
  return { id, moduleId, props, breakpointOverrides: {}, children }
}

const LAYOUT = {
  id: 'layout', title: 'Layout', slug: 'layout', rootNodeId: 'root',
  template: { enabled: true, target: { kind: 'everywhere' }, priority: 0 },
  seo: { description: 'Layout description', canonical: 'https://example.test/layout' },
  nodes: {
    root: node('root', 'base.body', {}, ['nav', 'outlet']),
    nav: node('nav', 'base.text', { text: 'Nav', tag: 'p' }),
    outlet: node('outlet', 'base.outlet', {}),
  },
} as unknown as SnapshotPage

const HOME = {
  id: 'page_home', title: 'Home', slug: 'index', rootNodeId: 'root',
  seo: {
    description: 'Home description',
    canonical: 'https://example.test/',
    jsonLd: ['{"@type":"WebSite","name":"Example"}'],
  },
  nodes: { root: node('root', 'base.body', {}, ['h']), h: node('h', 'base.text', { text: 'Home', tag: 'h1' }) },
} as unknown as SnapshotPage

const POSTS = {
  id: 'posts_template', title: 'Posts', slug: 'posts-template', rootNodeId: 'root',
  template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 },
  seo: {
    description: '{currentEntry.summary}',
    canonical: 'https://example.test/posts',
    robots: 'noindex',
    openGraph: { title: '{currentEntry.title} | Example', url: 'https://example.test/posts' },
  },
  nodes: {
    root: node('root', 'base.body', {}, ['h', 'outlet']),
    h: node('h', 'base.text', { text: '{currentEntry.title}', tag: 'h1' }),
    outlet: node('outlet', 'base.outlet', {}),
  },
} as unknown as SnapshotPage

function snapshot(posts: SnapshotPage = POSTS, home: SnapshotPage = HOME): PublishedPageSnapshot {
  return {
    cmsSnapshotVersion: 1,
    pageRowId: 'page_home',
    site: {
      id: 'project_1', name: 'Example',
      pages: [LAYOUT, home, posts],
      files: [], visualComponents: [],
      breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
      settings: { shortcuts: {} },
      styleRules: {}, createdAt: 1000, updatedAt: 2000,
    },
  }
}

function makeFakeDb(
  activeSnapshot: PublishedPageSnapshot | null,
  runtimeAssets: Record<string, unknown>[] = [],
): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    // Reconstruct a parameterized SQL string for pattern matching.
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    // getPublishedRuntimeAsset — values[0]=publicPath
    if (normalized.includes('select public_path, content_type, content_bytes')) {
      const row = runtimeAssets.find((asset) => asset.public_path === values[0])
      return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 }
    }
    // getPublishedPageBySlug / getLatestPublishedSiteSnapshot — joins
    // data_row_versions to site_snapshots
    if (normalized.includes('site_snapshots.site_json')) {
      return {
        rows: activeSnapshot
          ? [{
              row_id: activeSnapshot.pageRowId,
              site_json: activeSnapshot.site,
              runtime_assets_json: activeSnapshot.runtimeAssets ?? null,
              importmap_body: activeSnapshot.runtimePackageImportmap?.body ?? null,
              importmap_sha256: activeSnapshot.runtimePackageImportmap?.sha256 ?? null,
            } as unknown as Row]
          : [],
        rowCount: activeSnapshot ? 1 : 0,
      }
    }
    // getSetupStatus — public-rendering tests assume CMS is already set up
    if (normalized.includes('count(*) as count from site')) {
      return { rows: [{ count: 1 } as unknown as Row], rowCount: 1 }
    }
    if (normalized.includes('count(*) as count') && normalized.includes('from users')) {
      return { rows: [{ count: 1 } as unknown as Row], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return handle as DbClient
}

const ENTRY: PublishedDataRow = {
  id: 'ver_1', rowId: 'row_1', tableId: 'tbl_posts', tableSlug: 'posts', tableKind: 'posts',
  tableRouteBase: '/blog', versionNumber: 1, slug: 'hello',
  featuredMediaId: null, featuredMediaPath: null,
  authorUserId: null, authorName: null, authorRoleSlug: null, authorRoleName: null,
  publishedByUserId: null, publishedByName: null, publishedByRoleSlug: null, publishedByRoleName: null,
  publishedAt: '2024-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z',
  cells: { title: 'Hello', summary: 'A summary of hello' },
} as PublishedDataRow

const headOf = (html: string | undefined) => (html ?? '').slice(0, (html ?? '').indexOf('</head>'))

describe('page head settings on the public render path', () => {
  beforeEach(() => {
    resetForTests()
  })

  it('{page.*} tokens name the served page, not the layout wrapping it', async () => {
    const snap = snapshot(POSTS, { ...HOME, seo: { canonical: 'https://example.test{page.permalink}', openGraph: { title: '{page.title}' } } } as SnapshotPage)
    const { html } = await renderPublishedSnapshot(snap, { db: makeFakeDb(snap) })
    const head = headOf(html)
    expect(head).toContain('<link rel="canonical" href="https://example.test/">')
    expect(head).toContain('<meta property="og:title" content="Home">')
  })

  it('head values never read the query string or the visitor', async () => {
    const snap = snapshot(POSTS, { ...HOME, seo: { description: 'Ref {route.query.ref|none}', openGraph: { title: 'Hi {member.email|there}' } } } as SnapshotPage)
    const { html } = await renderPublishedSnapshot(snap, { db: makeFakeDb(snap), url: new URL('http://localhost/?ref=evil') })
    const head = headOf(html)
    expect(head).toContain('<meta name="description" content="Ref none">')
    expect(head).toContain('<meta property="og:title" content="Hi there">')
    expect(head).not.toContain('evil')
  })

  it('a page wrapped by an everywhere layout keeps its own head settings', async () => {
    const snap = snapshot()
    const { html } = await renderPublishedSnapshot(snap, { db: makeFakeDb(snap) })
    expect(html).toContain('<p>Nav</p>')
    const head = headOf(html)
    expect(head).toContain('<meta name="description" content="Home description">')
    expect(head).toContain('<link rel="canonical" href="https://example.test/">')
    expect(head).toContain('<script type="application/ld+json">{"@type":"WebSite","name":"Example"}</script>')
    expect(head).not.toContain('Layout description')
    expect(head).not.toContain('example.test/layout')
  })

  it('an entry uses its post-type template settings as a pattern', async () => {
    const snap = snapshot()
    const result = await renderPublishedDataRowTemplate(snap, ENTRY, { db: makeFakeDb(snap) })
    const head = headOf(result?.html)
    expect(head).toContain('<meta name="description" content="A summary of hello">')
    expect(head).toContain('<meta property="og:title" content="Hello | Example">')
    // A token-less template canonical would point every entry at one URL.
    expect(head).toContain('<link rel="canonical" href="https://example.test/blog/hello">')
    expect(head).not.toContain('og:url')
    expect(head).toContain('<meta name="robots" content="noindex">')
    expect(head).not.toContain('Layout description')
  })

  it("the entry's own SEO fields outrank the template, and a tokened canonical resolves per entry", async () => {
    const snap = snapshot({
      ...POSTS,
      seo: { ...POSTS.seo, canonical: 'https://example.test/blog/{currentEntry.slug}', openGraph: { url: 'https://example.test/blog/{currentEntry.slug}' } },
    } as SnapshotPage)
    const result = await renderPublishedDataRowTemplate(
      snap,
      { ...ENTRY, cells: { ...ENTRY.cells, seoTitle: 'Own title', seoDescription: 'Own description' } },
      { db: makeFakeDb(snap) },
    )
    const head = headOf(result?.html)
    expect(head).toContain('<title>Own title</title>')
    expect(head).toContain('<meta name="description" content="Own description">')
    expect(head).toContain('<link rel="canonical" href="https://example.test/blog/hello">')
    expect(head).toContain('<meta property="og:url" content="https://example.test/blog/hello">')
  })
})
