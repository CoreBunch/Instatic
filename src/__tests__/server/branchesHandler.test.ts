/**
 * Site branches endpoints — registry CRUD, capability + step-up gates, and
 * the header-scoped fallback once a branch is gone.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { upsertDataRowDraft } from '../../../server/repositories/data'
import {
  createCapabilityTestHarness,
  expectForbidden,
  expectStepUpRequired,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

const BRANCHES = '/admin/api/cms/branches'
const BRANCH_HEADER = 'x-instatic-branch'

interface BranchPayload {
  id: string
  name: string
  baseBranchId: string | null
}

describe('branches endpoints', () => {
  let harness: CapabilityTestHarness | null = null

  afterEach(async () => {
    await harness?.cleanup()
    harness = null
  })

  it('lists main, forks a branch, renames it, and scopes content requests by header', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()

    const initial = await readJson<{ branches: BranchPayload[] }>(await harness.cms(BRANCHES, { cookie: owner }))
    expect(initial.branches.map((branch) => branch.id)).toEqual(['main'])

    const created = await harness.cms(BRANCHES, {
      method: 'POST',
      cookie: owner,
      json: { name: 'Spring Redesign' },
    })
    expect(created.status).toBe(201)
    const { branch } = await readJson<{ branch: BranchPayload }>(created)
    expect(branch).toMatchObject({ id: 'spring-redesign', name: 'Spring Redesign', baseBranchId: 'main' })

    const listed = await readJson<{ branches: BranchPayload[] }>(await harness.cms(BRANCHES, { cookie: owner }))
    expect(listed.branches.map((entry) => entry.id)).toEqual(['main', 'spring-redesign'])

    // The fork carries the system tables, addressed through the header.
    const mainTables = await readJson<{ tables: Array<{ id: string }> }>(
      await harness.cms('/admin/api/cms/data/tables', { cookie: owner }),
    )
    const branchTables = await readJson<{ tables: Array<{ id: string }> }>(
      await harness.cms('/admin/api/cms/data/tables', {
        cookie: owner,
        headers: { [BRANCH_HEADER]: 'spring-redesign' },
      }),
    )
    expect(branchTables.tables.map((table) => table.id).sort()).toEqual(
      mainTables.tables.map((table) => table.id).sort(),
    )

    const renamed = await harness.cms(`${BRANCHES}/spring-redesign`, {
      method: 'PATCH',
      cookie: owner,
      json: { name: 'Spring 2027' },
    })
    expect(renamed.status).toBe(200)
    expect((await readJson<{ branch: BranchPayload }>(renamed)).branch.name).toBe('Spring 2027')

    const unknown = await harness.cms('/admin/api/cms/data/tables', {
      cookie: owner,
      headers: { [BRANCH_HEADER]: 'nope' },
    })
    expect(unknown.status).toBe(404)
    expect(await readJson<{ code: string }>(unknown)).toMatchObject({ code: 'branch_not_found' })
  })

  it('lets a stale branch header through the account routes and still refuses it on content', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    // A tab remembering a branch that no longer exists sends its header on
    // every request, the sign-in included; the account routes must not care.
    const stale = { 'X-Instatic-Branch': 'long-gone' }
    expect((await harness.cms('/admin/api/cms/setup/status', { headers: stale })).status).toBe(200)
    expect((await harness.cms('/admin/api/cms/me', { cookie: owner, headers: stale })).status).toBe(200)
    // Wrong password answers as a login failure, not as a missing branch.
    const login = await harness.cms('/admin/api/cms/login', {
      method: 'POST',
      headers: stale,
      json: { email: 'nobody@example.test', password: 'not-the-password' },
    })
    expect(login.status).toBe(401)
    // Content routes still refuse it, with the code the client falls back on.
    const content = await harness.cms(BRANCHES, { cookie: owner, headers: stale })
    expect(content.status).toBe(404)
    expect(await readJson<{ code: string }>(content)).toMatchObject({ code: 'branch_not_found' })
  })

  it('refuses duplicate ids, malformed ids, and any change to main', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    expect((await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name: 'Alpha' } })).status).toBe(201)

    const duplicate = await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name: 'alpha' } })
    expect(duplicate.status).toBe(409)

    const malformed = await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name: 'x', id: 'Bad:Id' } })
    expect(malformed.status).toBe(400)

    const recreateMain = await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name: 'main' } })
    expect(recreateMain.status).toBe(400)

    const renameMain = await harness.cms(`${BRANCHES}/main`, { method: 'PATCH', cookie: owner, json: { name: 'Live' } })
    expect(renameMain.status).toBe(400)

    const deleteMain = await harness.cms(`${BRANCHES}/main`, { method: 'DELETE', cookie: owner })
    expect(deleteMain.status).toBe(400)
  })

  it('splits forking from managing: creators reach their own branches, managers reach every branch and merge', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    expect((await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name: 'Doomed' } })).status).toBe(201)

    const reader = await harness.createRoleUser({
      name: 'Reader',
      slug: 'reader',
      capabilities: ['site.read'],
    })
    expect((await harness.cms(BRANCHES, { cookie: reader.cookie })).status).toBe(200)
    await expectForbidden(await harness.cms(BRANCHES, { method: 'POST', cookie: reader.cookie, json: { name: 'Nope' } }))
    await expectForbidden(await harness.cms(`${BRANCHES}/doomed`, { method: 'DELETE', cookie: reader.cookie }))

    // A creator forks, and reaches only what they forked: the owner's branch
    // stays out of bounds, and merging into main is never theirs.
    const creator = await harness.createRoleUser({
      name: 'Branch creator',
      slug: 'branch-creator',
      capabilities: ['site.read', 'site.branches.create'],
    })
    expect((await harness.cms(BRANCHES, { method: 'POST', cookie: creator.cookie, json: { name: 'Mine' } })).status).toBe(201)
    expect((await harness.cms(`${BRANCHES}/mine`, { method: 'PATCH', cookie: creator.cookie, json: { name: 'Mine renamed' } })).status).toBe(200)
    expect((await harness.cms(`${BRANCHES}/mine/preview`, { method: 'POST', cookie: creator.cookie })).status).toBe(201)
    await expectForbidden(await harness.cms(`${BRANCHES}/doomed`, { method: 'PATCH', cookie: creator.cookie, json: { name: 'Not yours' } }))
    await expectForbidden(await harness.cms(`${BRANCHES}/doomed/preview`, { method: 'POST', cookie: creator.cookie }))
    await expectForbidden(await harness.cms(`${BRANCHES}/mine/merge`, { method: 'POST', cookie: creator.cookie, json: {} }))

    // A manager reaches every branch and is the one who merges, but managing
    // alone does not fork.
    const manager = await harness.createRoleUser({
      name: 'Branch manager',
      slug: 'branch-manager',
      capabilities: ['site.read', 'site.branches.manage'],
    })
    await expectForbidden(await harness.cms(BRANCHES, { method: 'POST', cookie: manager.cookie, json: { name: 'No fork' } }))
    expect((await harness.cms(`${BRANCHES}/mine`, { method: 'PATCH', cookie: manager.cookie, json: { name: 'Mine, managed' } })).status).toBe(200)
    await expectStepUpRequired(await harness.cms(`${BRANCHES}/doomed`, { method: 'DELETE', cookie: manager.cookie }))

    const stepped = await harness.stepUp(manager.cookie)
    const deleted = await harness.cms(`${BRANCHES}/doomed`, { method: 'DELETE', cookie: stepped })
    expect(deleted.status).toBe(200)

    // The creator retires their own branch the same way, step-up included.
    const creatorStepped = await harness.stepUp(creator.cookie)
    expect((await harness.cms(`${BRANCHES}/mine`, { method: 'DELETE', cookie: creatorStepped })).status).toBe(200)

    const gone = await harness.cms('/admin/api/cms/data/tables', {
      cookie: owner,
      headers: { [BRANCH_HEADER]: 'doomed' },
    })
    expect(gone.status).toBe(404)
    expect(await readJson<{ code: string }>(gone)).toMatchObject({ code: 'branch_not_found' })

    const remaining = await readJson<{ branches: BranchPayload[] }>(await harness.cms(BRANCHES, { cookie: owner }))
    expect(remaining.branches.map((branch) => branch.id)).toEqual(['main'])
  })
})

describe('branch content on the canvas', () => {
  let harness: CapabilityTestHarness | null = null

  afterEach(async () => {
    await harness?.cleanup()
    harness = null
  })

  it('previews a branch loop from the branch\'s draft rows, and main from published rows only', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    expect((await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name: 'Loopy' } })).status).toBe(201)
    await upsertDataRowDraft(harness.db, { branchId: 'loopy' }, {
      id: 'branch-only',
      tableId: 'posts',
      cells: { title: 'Only on the branch', slug: 'only-on-the-branch' },
      slug: 'only-on-the-branch',
    })

    const onBranch = await readJson<{ items: Array<{ id: string }> }>(
      await harness.cms('/admin/api/cms/data/tables/posts/loop-preview', {
        cookie: owner,
        headers: { [BRANCH_HEADER]: 'loopy' },
      }),
    )
    expect(onBranch.items.map((item) => item.id)).toEqual(['branch-only'])

    const onMain = await readJson<{ items: Array<{ id: string }> }>(
      await harness.cms('/admin/api/cms/data/tables/posts/loop-preview', { cookie: owner }),
    )
    expect(onMain.items).toEqual([])
  })
})

describe('branch export', () => {
  let harness: CapabilityTestHarness | null = null

  afterEach(async () => {
    await harness?.cleanup()
    harness = null
  })

  function exportForm(request: Record<string, unknown>): { body: string; headers: Record<string, string> } {
    return {
      body: new URLSearchParams({ exportRequest: JSON.stringify(request) }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }
  }

  it('exports the branch named in the form body, and main without one', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    expect((await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name: 'Bundle' } })).status).toBe(201)
    await upsertDataRowDraft(harness.db, { branchId: 'bundle' }, {
      id: 'bundle-only',
      tableId: 'posts',
      cells: { title: 'Only in the bundle', slug: 'only-in-the-bundle' },
      slug: 'only-in-the-bundle',
    })

    // The download is a form POST (no branch header): the body names the branch.
    const onBranch = await harness.cms('/admin/api/cms/export', {
      method: 'POST',
      cookie: owner,
      ...exportForm({ includeMedia: false, branchId: 'bundle' }),
    })
    expect(onBranch.status).toBe(200)
    expect(onBranch.headers.get('content-type')).toContain('zip')
    // Stored (uncompressed) zip: the bundle JSON is readable in the body.
    expect(await onBranch.text()).toContain('only-in-the-bundle')

    const onMain = await harness.cms('/admin/api/cms/export', {
      method: 'POST',
      cookie: owner,
      ...exportForm({ includeMedia: false }),
    })
    expect(onMain.status).toBe(200)
    expect(await onMain.text()).not.toContain('only-in-the-bundle')

    const unknown = await harness.cms('/admin/api/cms/export', {
      method: 'POST',
      cookie: owner,
      ...exportForm({ includeMedia: false, branchId: 'nope' }),
    })
    expect(unknown.status).toBe(404)
    expect(await readJson<{ code: string }>(unknown)).toMatchObject({ code: 'branch_not_found' })
  })
})
