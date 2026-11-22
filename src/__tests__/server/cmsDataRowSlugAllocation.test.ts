/**
 * Creating a row whose slug is already taken.
 *
 * By default that is a named 409, so a script or connector can tell a
 * duplicate from a bug. The admin's New and Duplicate actions want "a new
 * row", not "this exact slug", and used to guess a free slug from whatever
 * list the browser had loaded — wrong whenever that list was still loading,
 * filtered, or stale. `allocateSlug` moves the choice to the server.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { handleCmsRequest } from '../../../server/handlers/cms'
import type { DbClient } from '../../../server/db'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

const PASSWORD = 'correct horse battery staple 42'
const ROWS_PATH = '/admin/api/cms/data/tables/posts/rows'

let open: TestDb[] = []

afterEach(async () => {
  for (const testDb of open) await testDb.cleanup()
  open = []
})

async function request(db: DbClient, path: string, options: { cookie?: string; json?: unknown } = {}): Promise<Response> {
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    ...(options.json !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.json) }
      : {}),
  })
  // Set after construction: `cookie` is dropped from a Request's init headers.
  if (options.cookie) req.headers.set('cookie', options.cookie)
  return handleCmsRequest(req, db)
}

function sessionCookie(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

async function ownerSession(): Promise<{ db: DbClient; cookie: string }> {
  const testDb = await createTestDb()
  open.push(testDb)
  const { db } = testDb
  const setup = await request(db, '/admin/api/cms/setup', {
    json: { siteName: 'Slug allocation', email: 'owner@example.com', password: PASSWORD },
  })
  expect(setup.status).toBe(201)
  const login = await request(db, '/admin/api/cms/login', { json: { email: 'owner@example.com', password: PASSWORD } })
  expect(login.status).toBe(200)
  // Row writes need a fresh step-up window; step-up rotates the session cookie.
  const stepUp = await request(db, '/admin/api/cms/auth/step-up', { cookie: sessionCookie(login), json: { password: PASSWORD } })
  expect(stepUp.status).toBe(200)
  return { db, cookie: sessionCookie(stepUp) }
}

async function createRow(db: DbClient, cookie: string, json: unknown): Promise<{ status: number; slug?: string; error?: string }> {
  const res = await request(db, ROWS_PATH, { cookie, json })
  const payload = await res.json() as { row?: { slug: string; cells: { slug?: string } }; error?: string }
  if (payload.row) expect(payload.row.cells.slug).toBe(payload.row.slug)
  return { status: res.status, slug: payload.row?.slug, error: payload.error }
}

describe('data row create with a taken slug', () => {
  it('answers 409 when the caller asked for that exact slug', async () => {
    const { db, cookie } = await ownerSession()
    expect((await createRow(db, cookie, { cells: { title: 'Untitled', slug: 'untitled' } })).status).toBe(201)

    const clash = await createRow(db, cookie, { cells: { title: 'Untitled', slug: 'untitled' } })
    expect(clash.status).toBe(409)
    expect(clash.error).toContain('"untitled" already exists')
  })

  it('stores the row under the next free slug when asked to allocate one', async () => {
    const { db, cookie } = await ownerSession()
    const untitled = { cells: { title: 'Untitled', slug: 'untitled' }, allocateSlug: true }

    expect((await createRow(db, cookie, untitled)).slug).toBe('untitled')
    expect((await createRow(db, cookie, untitled)).slug).toBe('untitled-2')
    expect((await createRow(db, cookie, untitled)).slug).toBe('untitled-3')
  })

  it('fills the first gap and ignores other slugs that only share the prefix', async () => {
    const { db, cookie } = await ownerSession()
    for (const slug of ['untitled', 'untitled-3', 'untitled-draft', 'untitled-20']) {
      expect((await createRow(db, cookie, { cells: { title: slug, slug } })).status).toBe(201)
    }

    const created = await createRow(db, cookie, { cells: { title: 'Untitled', slug: 'untitled' }, allocateSlug: true })
    expect(created.slug).toBe('untitled-2')
  })
})
