import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { handleCmsRequest } from '../../../server/handlers/cms'
import type { DbClient } from '../../../server/db'
import { persistSitePublish } from '../../../server/repositories/publish'
import { resetForTests } from '../../../server/publish/renderCache'
import { hookBus } from '../../core/plugins/hookBus'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { makePage, makeSite } from '../publisher/helpers'
import '@modules/base'

const password = 'long-enough-password'

async function request(
  db: DbClient,
  path: string,
  options: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const req = new Request(`http://localhost${path}`, { ...options, headers })
  // Set after construction: the Request constructor drops a `cookie` header.
  if (options.cookie) req.headers.set('cookie', options.cookie)
  return handleCmsRequest(req, db)
}

function sessionCookie(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

async function setupOwner(db: DbClient): Promise<string> {
  const setup = await request(db, '/admin/api/cms/setup', {
    method: 'POST',
    body: JSON.stringify({ siteName: 'Preview Path Test', email: 'owner@example.com', password }),
  })
  expect(setup.status).toBe(201)
  const login = await request(db, '/admin/api/cms/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'owner@example.com', password }),
  })
  expect(login.status).toBe(200)
  const stepUp = await request(db, '/admin/api/cms/auth/step-up', {
    method: 'POST',
    cookie: sessionCookie(login),
    body: JSON.stringify({ password }),
  })
  expect(stepUp.status).toBe(200)
  return sessionCookie(stepUp)
}

/** Publish a site snapshot whose only page is an entry template for `posts`. */
async function publishPostTemplate(db: DbClient): Promise<void> {
  const { rows: pageRows } = await db<{ id: string }>`
    select id from data_rows where table_id = 'pages' and deleted_at is null limit 1
  `
  const { rows: userRows } = await db<{ id: string }>`select id from users limit 1`
  const pageRowId = pageRows[0]!.id
  const template = makePage({
    root: { moduleId: 'base.body', props: {}, children: ['title'] },
    title: { moduleId: 'base.text', props: { text: 'Entry', tag: 'h1' } },
  })
  template.id = pageRowId
  template.title = 'Post Template'
  template.slug = 'post-template'
  template.template = {
    enabled: true,
    target: { kind: 'postTypes', tableSlugs: ['posts'] },
    priority: 100,
  }
  await persistSitePublish(db, {
    siteSnapshotId: crypto.randomUUID(),
    site: makeSite({ pages: [template] }),
    serializedImportmap: null,
    pages: [{
      pageId: pageRowId,
      title: template.title,
      slug: template.slug,
      versionId: crypto.randomUUID(),
      versionNumber: 1,
      runtimeAssets: null,
      runtimeFiles: [],
    }],
    publishedByUserId: userRows[0]!.id,
  })
}

describe('admin entry preview publish.html context', () => {
  const cleanupFns: Array<() => Promise<void>> = []

  // resetForTests also clears the version-keyed memos (incl. the module-JS
  // map the preview populates) so no state leaks into other test files.
  beforeEach(() => {
    resetForTests()
    hookBus.reset()
  })

  afterEach(async () => {
    resetForTests()
    hookBus.reset()
    while (cleanupFns.length) await cleanupFns.pop()?.()
  })

  async function makeDb(): Promise<TestDb> {
    const testDb = await createTestDb()
    cleanupFns.push(testDb.cleanup)
    return testDb
  }

  it('reports the percent-encoded public pathname as `path`, matching live and baked renders', async () => {
    const { db } = await makeDb()
    const cookie = await setupOwner(db)
    await publishPostTemplate(db)

    const created = await request(db, '/admin/api/cms/data/tables/posts/rows', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ cells: { title: 'Cafe post', slug: 'cafe-post' } }),
    })
    expect(created.status).toBe(201)
    const { row } = await created.json() as { row: { id: string } }

    hookBus.filter('fx-04-regression', 'publish.html', (html, context) => {
      const { path } = context as { path?: string }
      return `${html}<!--publish-path:${JSON.stringify(path ?? null)}-->`
    })

    const preview = await request(db, `/admin/api/cms/data/rows/${row.id}/preview`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ cells: { slug: 'café' } }),
    })
    const html = await preview.text()
    expect(preview.status).toBe(200)

    const reported = /<!--publish-path:(.*?)-->/.exec(html)?.[1]
    expect(reported).toBeDefined()
    const expected = new URL('http://x/posts/café').pathname
    expect(expected).toBe('/posts/caf%C3%A9')
    expect(JSON.parse(reported!)).toBe(expected)
  })
})
