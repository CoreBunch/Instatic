import { afterEach, describe, expect, it } from 'bun:test'
import { handleCmsRequest } from '../../../server/handlers/cms'
import type { DbClient } from '../../../server/db'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { registerPublishFlush } from '../../../server/publish/publishFlush'
import { upsertDataRowDraft } from '../../../server/repositories/data'

const ownedPassword = 'long-enough-password'

async function body(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>
}

async function request(
  db: DbClient,
  path: string,
  options: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const req = new Request(`http://localhost${path}`, {
    ...options,
    headers,
  })
  if (options.cookie) req.headers.set('cookie', options.cookie)
  return handleCmsRequest(req, db)
}

async function setupOwner(db: DbClient): Promise<string> {
  const setup = await request(db, '/admin/api/cms/setup', {
    method: 'POST',
    body: JSON.stringify({
      siteName: 'Ownership Test',
      email: 'owner@example.com',
      password: ownedPassword,
    }),
  })
  expect(setup.status).toBe(201)
  return stepUp(db, await login(db, 'owner@example.com'))
}

async function login(db: DbClient, email: string): Promise<string> {
  const res = await request(db, '/admin/api/cms/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: ownedPassword }),
  })
  expect(res.status).toBe(200)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  expect(cookie).toContain('instatic_admin_session=')
  return cookie
}

async function stepUp(db: DbClient, cookie: string): Promise<string> {
  const res = await request(db, '/admin/api/cms/auth/step-up', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ password: ownedPassword }),
  })
  expect(res.status).toBe(200)
  const steppedCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  expect(steppedCookie).toContain('instatic_admin_session=')
  return steppedCookie
}

async function createUser(
  db: DbClient,
  ownerCookie: string,
  input: { email: string; displayName: string; roleId: string },
): Promise<string> {
  const res = await request(db, '/admin/api/cms/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: JSON.stringify({ ...input, password: ownedPassword }),
  })
  expect(res.status).toBe(201)
  const payload = await body(res) as { user: { id: string } }
  return payload.user.id
}

/**
 * Create a custom role with the given capabilities and return its id. Used
 * by the ownership tests, which need granular capability sets (own-edit vs
 * any-edit, etc.) that no built-in role exposes — built-in roles are now
 * limited to owner / admin / client / member.
 */
async function createCustomRole(
  db: DbClient,
  ownerCookie: string,
  input: { slug: string; name: string; capabilities: string[] },
): Promise<string> {
  const res = await request(db, '/admin/api/cms/roles', {
    method: 'POST',
    cookie: ownerCookie,
    body: JSON.stringify({
      name: input.name,
      slug: input.slug,
      description: '',
      capabilities: input.capabilities,
    }),
  })
  expect(res.status).toBe(201)
  const payload = await body(res) as { role: { id: string } }
  return payload.role.id
}

const OWN_EDIT_CAPS = [
  'site.read',
  'content.create',
  'content.edit.own',
  'content.publish.own',
]

const ANY_EDIT_CAPS = [
  'site.read',
  'content.create',
  'content.edit.any',
  'content.publish.any',
  'content.manage',
  'media.read',
  'media.write',
  'media.replace',
  'media.delete',
]

async function createRow(
  db: DbClient,
  cookie: string,
  title: string,
): Promise<string> {
  const res = await request(db, '/admin/api/cms/data/tables/posts/rows', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ cells: { title } }),
  })
  expect(res.status).toBe(201)
  const payload = await body(res) as { row: { id: string } }
  return payload.row.id
}

async function createTable(
  db: DbClient,
  cookie: string,
  input: { name: string; slug: string; kind: 'data' | 'postType' },
): Promise<string> {
  const fields = input.kind === 'postType'
    ? [
        { id: 'title', label: 'Title', type: 'text', required: true },
        { id: 'slug', label: 'Slug', type: 'text', required: true },
      ]
    : [
        { id: 'title', label: 'Title', type: 'text', required: true },
      ]
  const res = await request(db, '/admin/api/cms/data/tables', {
    method: 'POST',
    cookie,
    body: JSON.stringify({
      name: input.name,
      slug: input.slug,
      kind: input.kind,
      singularLabel: input.name,
      pluralLabel: input.name,
      fields,
    }),
  })
  expect(res.status).toBe(201)
  const payload = await body(res) as { table: { id: string } }
  return payload.table.id
}

async function createRowInTable(
  db: DbClient,
  cookie: string,
  tableId: string,
  title: string,
): Promise<string> {
  return createRowInTableWithCells(db, cookie, tableId, { title })
}

async function createRowInTableWithCells(
  db: DbClient,
  cookie: string,
  tableId: string,
  cells: Record<string, unknown>,
): Promise<string> {
  const res = await request(db, `/admin/api/cms/data/tables/${tableId}/rows`, {
    method: 'POST',
    cookie,
    body: JSON.stringify({ cells }),
  })
  expect(res.status).toBe(201)
  const payload = await body(res) as { row: { id: string } }
  return payload.row.id
}

describe('CMS data ownership authorization', () => {
  const cleanupFns: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanupFns.length) await cleanupFns.pop()?.()
  })

  async function makeDb(): Promise<TestDb> {
    const testDb = await createTestDb()
    cleanupFns.push(testDb.cleanup)
    return testDb
  }

  it('filters own-edit users to their rows and lets any-edit users see all rows', async () => {
    const { db } = await makeDb()
    const ownerCookie = await setupOwner(db)
    const ownEditRoleId = await createCustomRole(db, ownerCookie, {
      slug: 'own-editor', name: 'Own Editor', capabilities: OWN_EDIT_CAPS,
    })
    const anyEditRoleId = await createCustomRole(db, ownerCookie, {
      slug: 'any-editor', name: 'Any Editor', capabilities: ANY_EDIT_CAPS,
    })
    await createUser(db, ownerCookie, { email: 'editor-one@example.com', displayName: 'Editor One', roleId: ownEditRoleId })
    await createUser(db, ownerCookie, { email: 'editor-two@example.com', displayName: 'Editor Two', roleId: ownEditRoleId })
    await createUser(db, ownerCookie, { email: 'manager@example.com', displayName: 'Manager', roleId: anyEditRoleId })
    const editorOneCookie = await login(db, 'editor-one@example.com')
    const editorTwoCookie = await login(db, 'editor-two@example.com')
    const managerCookie = await login(db, 'manager@example.com')

    await createRow(db, editorOneCookie, 'Editor One Draft')
    await createRow(db, editorTwoCookie, 'Editor Two Draft')

    const ownList = await request(db, '/admin/api/cms/data/tables/posts/rows', {
      method: 'GET',
      cookie: editorOneCookie,
    })
    expect(ownList.status).toBe(200)
    const ownRows = (await body(ownList)).rows as Array<{ cells: { title: string } }>
    expect(ownRows.map((r) => r.cells.title)).toEqual(['Editor One Draft'])

    const allList = await request(db, '/admin/api/cms/data/tables/posts/rows', {
      method: 'GET',
      cookie: managerCookie,
    })
    expect(allList.status).toBe(200)
    const allRows = (await body(allList)).rows as Array<{ cells: { title: string } }>
    expect(allRows.map((r) => r.cells.title).sort()).toEqual([
      'Editor One Draft',
      'Editor Two Draft',
    ])
  })

  it('blocks own-edit users from mutating rows owned by someone else', async () => {
    const { db } = await makeDb()
    const ownerCookie = await setupOwner(db)
    const ownEditRoleId = await createCustomRole(db, ownerCookie, {
      slug: 'own-editor', name: 'Own Editor', capabilities: OWN_EDIT_CAPS,
    })
    const editorTwoId = await createUser(db, ownerCookie, {
      email: 'second-editor@example.com',
      displayName: 'Second Editor',
      roleId: ownEditRoleId,
    })
    await createUser(db, ownerCookie, { email: 'first-editor@example.com', displayName: 'First Editor', roleId: ownEditRoleId })
    const firstEditorCookie = await login(db, 'first-editor@example.com')
    const secondEditorCookie = await login(db, 'second-editor@example.com')
    const secondRowId = await createRow(db, secondEditorCookie, 'Second Editor Draft')

    const readOther = await request(db, `/admin/api/cms/data/rows/${secondRowId}`, {
      method: 'GET',
      cookie: firstEditorCookie,
    })
    expect(readOther.status).toBe(403)

    const saveOther = await request(db, `/admin/api/cms/data/rows/${secondRowId}`, {
      method: 'PATCH',
      cookie: firstEditorCookie,
      body: JSON.stringify({
        cells: {
          title: 'Hijacked',
          slug: 'hijacked',
          body: '',
          featuredMedia: null,
          seoTitle: '',
          seoDescription: '',
        },
      }),
    })
    expect(saveOther.status).toBe(403)

    const reassignOther = await request(db, `/admin/api/cms/data/rows/${secondRowId}/author`, {
      method: 'PATCH',
      cookie: firstEditorCookie,
      body: JSON.stringify({ authorUserId: editorTwoId }),
    })
    expect(reassignOther.status).toBe(403)
  })

  it('lets own-publish users publish their rows and any-edit users reassign authors', async () => {
    const { db } = await makeDb()
    const ownerCookie = await setupOwner(db)
    const ownEditRoleId = await createCustomRole(db, ownerCookie, {
      slug: 'own-editor', name: 'Own Editor', capabilities: OWN_EDIT_CAPS,
    })
    const anyEditRoleId = await createCustomRole(db, ownerCookie, {
      slug: 'any-editor', name: 'Any Editor', capabilities: ANY_EDIT_CAPS,
    })
    const editorOneId = await createUser(db, ownerCookie, {
      email: 'publish-editor@example.com',
      displayName: 'Publish Editor',
      roleId: ownEditRoleId,
    })
    const managerId = await createUser(db, ownerCookie, {
      email: 'assign-manager@example.com',
      displayName: 'Assign Manager',
      roleId: anyEditRoleId,
    })
    const editorCookie = await login(db, 'publish-editor@example.com')
    const managerCookie = await login(db, 'assign-manager@example.com')
    const rowId = await createRow(db, editorCookie, 'Publishable Draft')

    const publish = await request(db, `/admin/api/cms/data/rows/${rowId}/publish`, {
      method: 'POST',
      cookie: editorCookie,
    })
    expect(publish.status).toBe(200)
    expect(await body(publish)).toMatchObject({ row: { status: 'published', authorUserId: editorOneId } })

    const reassign = await request(db, `/admin/api/cms/data/rows/${rowId}/author`, {
      method: 'PATCH',
      cookie: managerCookie,
      body: JSON.stringify({ authorUserId: managerId }),
    })
    expect(reassign.status).toBe(200)
    expect(await body(reassign)).toMatchObject({ row: { authorUserId: managerId } })
  })

  it('flushes the collab relay before reading the row to schedule', async () => {
    // A page created in the visual editor lives only in the relay's in-memory
    // doc until its persist debounce elapses. Scheduling one right after
    // creating it used to 404 with "Data row not found" because this handler
    // read the DB directly — publish flushes, so "publish later" must too.
    const { db } = await makeDb()
    const ownerCookie = await setupOwner(db)

    const relayResidentId = 'relay-resident-row'
    let flushed = false
    // Stands in for the relay persisting a doc that has no DB row yet. The
    // handler's own flush is the ONLY thing that can make this row exist.
    const detach = registerPublishFlush(async () => {
      flushed = true
      await upsertDataRowDraft(
        db,
        {
          id: relayResidentId,
          tableId: 'posts',
          cells: { title: 'Relay-resident page' },
          slug: 'relay-resident-page',
        },
        null,
        { collabInternal: true },
      )
    })
    cleanupFns.push(async () => detach())

    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const schedule = await request(db, `/admin/api/cms/data/rows/${relayResidentId}/schedule`, {
      method: 'POST',
      cookie: ownerCookie,
      body: JSON.stringify({ at: scheduledAt }),
    })

    expect(flushed).toBe(true)
    expect(schedule.status).toBe(200)
    expect(await body(schedule)).toMatchObject({
      row: { id: relayResidentId, status: 'scheduled' },
    })
  })

  it('schedules and cancels row publication only through the schedule endpoint', async () => {
    const { db } = await makeDb()
    const ownerCookie = await setupOwner(db)
    const rowId = await createRow(db, ownerCookie, 'Scheduled Draft')

    const past = await request(db, `/admin/api/cms/data/rows/${rowId}/schedule`, {
      method: 'POST',
      cookie: ownerCookie,
      body: JSON.stringify({ at: '2001-01-01T00:00:00.000Z' }),
    })
    expect(past.status).toBe(400)
    expect(await body(past)).toEqual({ error: 'Scheduled time must be in the future' })

    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const schedule = await request(db, `/admin/api/cms/data/rows/${rowId}/schedule`, {
      method: 'POST',
      cookie: ownerCookie,
      body: JSON.stringify({ at: scheduledAt }),
    })
    expect(schedule.status).toBe(200)
    expect(await body(schedule)).toMatchObject({
      row: {
        id: rowId,
        status: 'scheduled',
        scheduledPublishAt: scheduledAt,
      },
    })

    const cancel = await request(db, `/admin/api/cms/data/rows/${rowId}/schedule`, {
      method: 'DELETE',
      cookie: ownerCookie,
    })
    expect(cancel.status).toBe(200)
    expect(await body(cancel)).toMatchObject({
      row: {
        id: rowId,
        status: 'draft',
        scheduledPublishAt: null,
      },
    })

    const cancelAgain = await request(db, `/admin/api/cms/data/rows/${rowId}/schedule`, {
      method: 'DELETE',
      cookie: ownerCookie,
    })
    expect(cancelAgain.status).toBe(404)
    expect(await body(cancelAgain)).toEqual({ error: 'Data row not found' })
  })

  it('clears scheduled publish metadata when a scheduled row is retracted by status', async () => {
    const { db } = await makeDb()
    const ownerCookie = await setupOwner(db)
    const rowId = await createRow(db, ownerCookie, 'Scheduled Status Retraction')
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    const schedule = await request(db, `/admin/api/cms/data/rows/${rowId}/schedule`, {
      method: 'POST',
      cookie: ownerCookie,
      body: JSON.stringify({ at: scheduledAt }),
    })
    expect(schedule.status).toBe(200)
    expect(await body(schedule)).toMatchObject({
      row: {
        id: rowId,
        status: 'scheduled',
        scheduledPublishAt: scheduledAt,
      },
    })

    const retract = await request(db, `/admin/api/cms/data/rows/${rowId}/status`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: JSON.stringify({ status: 'draft' }),
    })
    expect(retract.status).toBe(200)
    expect(await body(retract)).toMatchObject({
      row: {
        id: rowId,
        status: 'draft',
        scheduledPublishAt: null,
      },
    })
  })

  it('rejects unsupported status payloads and leaves publish routed to the publish endpoint', async () => {
    const { db } = await makeDb()
    const ownerCookie = await setupOwner(db)
    const rowId = await createRow(db, ownerCookie, 'Status Boundary')

    const invalidStatus = await request(db, `/admin/api/cms/data/rows/${rowId}/status`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: JSON.stringify({ status: 'published' }),
    })
    expect(invalidStatus.status).toBe(400)
    expect(await body(invalidStatus)).toEqual({ error: 'Status must be draft or unpublished' })

    const publish = await request(db, `/admin/api/cms/data/rows/${rowId}/publish`, {
      method: 'POST',
      cookie: ownerCookie,
    })
    expect(publish.status).toBe(200)
    expect(await body(publish)).toMatchObject({ row: { id: rowId, status: 'published' } })

    const unpublish = await request(db, `/admin/api/cms/data/rows/${rowId}/status`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: JSON.stringify({ status: 'unpublished' }),
    })
    expect(unpublish.status).toBe(200)
    expect(await body(unpublish)).toMatchObject({
      row: {
        id: rowId,
        status: 'unpublished',
        publishedAt: null,
        publishedByUserId: null,
      },
    })
  })

  it('rejects blank or inactive row authors before changing attribution', async () => {
    const { db } = await makeDb()
    const ownerCookie = await setupOwner(db)
    const rowId = await createRow(db, ownerCookie, 'Author Boundary')
    const inactiveAuthorId = await createUser(db, ownerCookie, {
      email: 'inactive-author@example.com',
      displayName: 'Inactive Author',
      roleId: 'member',
    })
    await db`update users set status = ${'suspended'} where id = ${inactiveAuthorId}`

    const blank = await request(db, `/admin/api/cms/data/rows/${rowId}/author`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: JSON.stringify({ authorUserId: '   ' }),
    })
    expect(blank.status).toBe(400)
    expect(await body(blank)).toEqual({ error: 'Author is required' })

    const inactive = await request(db, `/admin/api/cms/data/rows/${rowId}/author`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: JSON.stringify({ authorUserId: inactiveAuthorId }),
    })
    expect(inactive.status).toBe(400)
    expect(await body(inactive)).toEqual({ error: 'Author must be an active user' })

    const row = await request(db, `/admin/api/cms/data/rows/${rowId}`, {
      method: 'GET',
      cookie: ownerCookie,
    })
    expect(row.status).toBe(200)
    expect(await body(row)).not.toMatchObject({ row: { authorUserId: inactiveAuthorId } })
  })

  it('rejects draft previews for plain data tables before template rendering', async () => {
    const { db } = await makeDb()
    const ownerCookie = await setupOwner(db)
    const tableId = await createTable(db, ownerCookie, {
      name: 'Preview Plain Data',
      slug: 'preview-plain-data',
      kind: 'data',
    })
    const rowId = await createRowInTable(db, ownerCookie, tableId, 'Plain Data Row')

    const preview = await request(db, `/admin/api/cms/data/rows/${rowId}/preview`, {
      method: 'POST',
      cookie: ownerCookie,
      body: JSON.stringify({ cells: { title: 'Draft title' } }),
    })
    expect(preview.status).toBe(400)
    expect(await body(preview)).toEqual({ error: 'Only post-type rows can be previewed' })
  })

  it('rejects table moves that would collide with an existing target slug', async () => {
    const { db } = await makeDb()
    const ownerCookie = await setupOwner(db)
    const sourceTableId = await createTable(db, ownerCookie, {
      name: 'Move Source',
      slug: 'move-source',
      kind: 'postType',
    })
    const targetTableId = await createTable(db, ownerCookie, {
      name: 'Move Target',
      slug: 'move-target',
      kind: 'postType',
    })
    const sourceRowId = await createRowInTableWithCells(db, ownerCookie, sourceTableId, {
      title: 'Source row',
      slug: 'shared-slug',
    })
    await createRowInTableWithCells(db, ownerCookie, targetTableId, {
      title: 'Target row',
      slug: 'shared-slug',
    })

    const move = await request(db, `/admin/api/cms/data/rows/${sourceRowId}/table`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: JSON.stringify({ tableId: targetTableId }),
    })
    expect(move.status).toBe(409)
    expect(await body(move)).toEqual({ error: 'A row with this slug already exists in the target table' })

    const row = await request(db, `/admin/api/cms/data/rows/${sourceRowId}`, {
      method: 'GET',
      cookie: ownerCookie,
    })
    expect(row.status).toBe(200)
    expect(await body(row)).toMatchObject({
      row: {
        id: sourceRowId,
        tableId: sourceTableId,
        slug: 'shared-slug',
      },
    })
  })
})
