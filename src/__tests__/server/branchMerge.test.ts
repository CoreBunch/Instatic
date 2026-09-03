/**
 * Merging a branch into main and updating a branch from main — plans,
 * field-level merges, conflicts and their resolutions, bases moving on, and
 * the endpoints' gates.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { applyBranchMerge, planBranchMerge } from '../../../server/branches/merge'
import { getDataRow, listDataRows, saveDataRowDraft, softDeleteDataRow, upsertDataRowDraft } from '../../../server/repositories/data'
import { getDraftSite, saveDraftSite } from '../../../server/repositories/site'
import {
  createCapabilityTestHarness,
  expectStepUpRequired,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

const BRANCHES = '/admin/api/cms/branches'

async function forkViaApi(harness: CapabilityTestHarness, owner: string, name: string): Promise<string> {
  const res = await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name } })
  expect(res.status).toBe(201)
  return (await readJson<{ branch: { id: string } }>(res)).branch.id
}

describe('branch merge', () => {
  let harness: CapabilityTestHarness | null = null

  afterEach(async () => {
    await harness?.cleanup()
    harness = null
  })

  it('carries branch-only edits and additions into main and moves the bases on', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const branchId = await forkViaApi(harness, owner, 'Feature')
    const branch = { branchId }

    // Nothing to merge right after a fork.
    expect((await planBranchMerge(harness.db, branchId, 'merge')).plan.changes).toEqual([])

    const [home] = await listDataRows(harness.db, branch, 'pages')
    await saveDataRowDraft(harness.db, branch, home!.id, {
      cells: { ...home!.cells, title: 'Branch title' },
      slug: home!.slug,
    })
    await upsertDataRowDraft(harness.db, branch, {
      id: 'branch-post',
      tableId: 'posts',
      cells: { title: 'Written on the branch', slug: 'written-on-the-branch' },
      slug: 'written-on-the-branch',
    })
    const shell = (await getDraftSite(harness.db, branch))!
    await saveDraftSite(harness.db, branch, { ...shell, name: 'Renamed on branch' })

    const { plan } = await planBranchMerge(harness.db, branchId, 'merge')
    expect(plan.conflictCount).toBe(0)
    expect(plan.changes.map((change) => [change.kind, change.action, change.label])).toEqual([
      ['site', 'update', 'Site settings'],
      ['row', 'update', 'Branch title'],
      ['row', 'create', 'Written on the branch'],
    ])

    await applyBranchMerge(harness.db, { branchId, direction: 'merge', resolutions: {}, actorUserId: null })
    expect((await getDataRow(harness.db, MAIN_SCOPE, home!.id))!.cells.title).toBe('Branch title')
    expect((await getDataRow(harness.db, MAIN_SCOPE, 'branch-post'))!.cells.title).toBe('Written on the branch')
    expect((await getDraftSite(harness.db, MAIN_SCOPE))!.name).toBe('Renamed on branch')
    // Both sides agree now, so a second plan is empty in either direction.
    expect((await planBranchMerge(harness.db, branchId, 'merge')).plan.changes).toEqual([])
    expect((await planBranchMerge(harness.db, branchId, 'update')).plan.changes).toEqual([])
  })

  it('merges different fields of the same row and flags the same field as a conflict', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const branchId = await forkViaApi(harness, owner, 'Both')
    const branch = { branchId }
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')

    // Disjoint fields: main edits the SEO title, the branch edits the title.
    await saveDataRowDraft(harness.db, MAIN_SCOPE, home!.id, {
      cells: { ...home!.cells, seoTitle: 'Main SEO' },
      slug: home!.slug,
    })
    await saveDataRowDraft(harness.db, branch, home!.id, {
      cells: { ...home!.cells, title: 'Branch title' },
      slug: home!.slug,
    })
    const disjoint = await planBranchMerge(harness.db, branchId, 'merge')
    expect(disjoint.plan.changes).toHaveLength(1)
    expect(disjoint.plan.conflictCount).toBe(0)
    await applyBranchMerge(harness.db, { branchId, direction: 'merge', resolutions: {}, actorUserId: null })
    const merged = (await getDataRow(harness.db, MAIN_SCOPE, home!.id))!
    expect(merged.cells).toMatchObject({ title: 'Branch title', seoTitle: 'Main SEO' })
    // The branch converged onto the same content.
    expect((await getDataRow(harness.db, branch, home!.id))!.cells).toMatchObject({ title: 'Branch title', seoTitle: 'Main SEO' })

    // Same field: a conflict that needs a decision.
    await saveDataRowDraft(harness.db, MAIN_SCOPE, home!.id, { cells: { ...merged.cells, title: 'Main wins' }, slug: home!.slug })
    await saveDataRowDraft(harness.db, branch, home!.id, { cells: { ...merged.cells, title: 'Branch wins' }, slug: home!.slug })
    const conflicted = await planBranchMerge(harness.db, branchId, 'merge')
    expect(conflicted.plan.conflictCount).toBe(1)
    expect(conflicted.plan.changes[0]!.conflicts).toEqual(['cells.title'])
    await expect(
      applyBranchMerge(harness.db, { branchId, direction: 'merge', resolutions: {}, actorUserId: null }),
    ).rejects.toThrow('Resolve 1 conflicting change')

    const key = conflicted.plan.changes[0]!.key
    await applyBranchMerge(harness.db, { branchId, direction: 'merge', resolutions: { [key]: 'from' }, actorUserId: null })
    expect((await getDataRow(harness.db, MAIN_SCOPE, home!.id))!.cells.title).toBe('Branch wins')
    expect((await planBranchMerge(harness.db, branchId, 'merge')).plan.changes).toEqual([])
  })

  it('updates a branch from main and treats delete-versus-edit as a conflict', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const branchId = await forkViaApi(harness, owner, 'Behind')
    const branch = { branchId }

    await upsertDataRowDraft(harness.db, MAIN_SCOPE, {
      id: 'main-post',
      tableId: 'posts',
      cells: { title: 'Written on main', slug: 'written-on-main' },
      slug: 'written-on-main',
    })
    const update = await planBranchMerge(harness.db, branchId, 'update')
    expect(update.plan.changes.map((change) => [change.action, change.label])).toEqual([['create', 'Written on main']])
    await applyBranchMerge(harness.db, { branchId, direction: 'update', resolutions: {}, actorUserId: null })
    expect((await getDataRow(harness.db, branch, 'main-post'))!.cells.title).toBe('Written on main')

    // Main deletes the post, the branch edits it.
    await softDeleteDataRow(harness.db, MAIN_SCOPE, 'main-post')
    await saveDataRowDraft(harness.db, branch, 'main-post', { cells: { title: 'Edited on branch', slug: 'written-on-main' }, slug: 'written-on-main' })
    const merge = await planBranchMerge(harness.db, branchId, 'merge')
    expect(merge.plan.changes.map((change) => [change.action, change.conflicts])).toEqual([['create', ['(deleted)']]])
    const key = merge.plan.changes[0]!.key
    // Keeping main's deletion drops the branch's edit too.
    await applyBranchMerge(harness.db, { branchId, direction: 'merge', resolutions: { [key]: 'into' }, actorUserId: null })
    expect(await getDataRow(harness.db, MAIN_SCOPE, 'main-post')).toBeNull()
    expect(await getDataRow(harness.db, branch, 'main-post')).toBeNull()
  })

  it('exposes plan and apply over HTTP, step-up gated, and can delete the branch afterwards', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const branchId = await forkViaApi(harness, owner, 'Ship It')
    await upsertDataRowDraft(harness.db, { branchId }, {
      id: 'shipped',
      tableId: 'posts',
      cells: { title: 'Shipped', slug: 'shipped' },
      slug: 'shipped',
    })

    const planned = await readJson<{ plan: { changes: unknown[] } }>(
      await harness.cms(`${BRANCHES}/${branchId}/merge`, { cookie: owner }),
    )
    expect(planned.plan.changes).toHaveLength(1)

    const manager = await harness.createRoleUser({
      name: 'Merger',
      slug: 'merger',
      capabilities: ['site.read', 'site.branches.manage'],
    })
    await expectStepUpRequired(
      await harness.cms(`${BRANCHES}/${branchId}/merge`, { method: 'POST', cookie: manager.cookie, json: {} }),
    )
    const applied = await harness.cms(`${BRANCHES}/${branchId}/merge`, {
      method: 'POST',
      cookie: owner,
      json: { deleteBranch: true },
    })
    expect(applied.status).toBe(200)
    expect(await readJson<{ branchDeleted: boolean }>(applied)).toMatchObject({ branchDeleted: true })
    expect((await getDataRow(harness.db, MAIN_SCOPE, 'shipped'))!.cells.title).toBe('Shipped')
    const remaining = await readJson<{ branches: Array<{ id: string }> }>(await harness.cms(BRANCHES, { cookie: owner }))
    expect(remaining.branches.map((branch) => branch.id)).toEqual(['main'])
  })
})

describe('branch merge — direction and base bookkeeping', () => {
  let harness: CapabilityTestHarness | null = null

  afterEach(async () => {
    await harness?.cleanup()
    harness = null
  })

  it('updating a branch from main never writes main, and the base becomes main as of the update', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const branchId = await forkViaApi(harness, owner, 'Downstream')
    const branch = { branchId }
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')

    // Main edits the SEO title; the branch edits the title of the same row.
    await saveDataRowDraft(harness.db, MAIN_SCOPE, home!.id, { cells: { ...home!.cells, seoTitle: 'Main SEO' }, slug: home!.slug })
    await saveDataRowDraft(harness.db, branch, home!.id, { cells: { ...home!.cells, title: 'Branch title' }, slug: home!.slug })
    const mainBefore = (await getDataRow(harness.db, MAIN_SCOPE, home!.id))!

    await applyBranchMerge(harness.db, { branchId, direction: 'update', resolutions: {}, actorUserId: null })
    // The branch has both; main is byte-identical to before the update.
    expect((await getDataRow(harness.db, branch, home!.id))!.cells).toMatchObject({ title: 'Branch title', seoTitle: 'Main SEO' })
    const mainAfter = (await getDataRow(harness.db, MAIN_SCOPE, home!.id))!
    expect(mainAfter.cells).toEqual(mainBefore.cells)
    expect(mainAfter.updatedAt).toBe(mainBefore.updatedAt)

    // The branch's own change is still a pending merge, with no conflict.
    const next = await planBranchMerge(harness.db, branchId, 'merge')
    expect(next.plan.changes.map((change) => [change.action, change.conflicts])).toEqual([['update', []]])
    // A "keep branch" decision on a delete-versus-edit conflict must not resurrect main's deletion either.
    await softDeleteDataRow(harness.db, MAIN_SCOPE, home!.id)
    const conflicted = await planBranchMerge(harness.db, branchId, 'update')
    expect(conflicted.plan.changes.map((change) => [change.action, change.conflicts])).toEqual([['delete', ['(deleted)']]])
    const key = conflicted.plan.changes[0]!.key
    await applyBranchMerge(harness.db, { branchId, direction: 'update', resolutions: { [key]: 'into' }, actorUserId: null })
    expect(await getDataRow(harness.db, MAIN_SCOPE, home!.id)).toBeNull()
    expect((await getDataRow(harness.db, branch, home!.id))!.cells.title).toBe('Branch title')
  })

  it('moves the base forward when both sides converge, so a later edit is not a conflict', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const branchId = await forkViaApi(harness, owner, 'Converge')
    const branch = { branchId }
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')

    await saveDataRowDraft(harness.db, MAIN_SCOPE, home!.id, { cells: { ...home!.cells, title: 'Same' }, slug: home!.slug })
    await saveDataRowDraft(harness.db, branch, home!.id, { cells: { ...home!.cells, title: 'Same' }, slug: home!.slug })
    expect((await planBranchMerge(harness.db, branchId, 'merge')).plan.changes).toEqual([])
    await applyBranchMerge(harness.db, { branchId, direction: 'merge', resolutions: {}, actorUserId: null })

    await saveDataRowDraft(harness.db, branch, home!.id, { cells: { ...home!.cells, title: 'Later' }, slug: home!.slug })
    const later = await planBranchMerge(harness.db, branchId, 'merge')
    expect(later.plan.changes.map((change) => [change.action, change.conflicts])).toEqual([['update', []]])
  })

  it('records fork bases from main, so a branch forked off another branch merges the parent\'s work too', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const parentId = await forkViaApi(harness, owner, 'Parent')
    await upsertDataRowDraft(harness.db, { branchId: parentId }, {
      id: 'parent-post',
      tableId: 'posts',
      cells: { title: 'From the parent', slug: 'from-the-parent' },
      slug: 'from-the-parent',
    })
    const child = await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name: 'Child', fromBranchId: parentId } })
    expect(child.status).toBe(201)
    const childId = (await readJson<{ branch: { id: string } }>(child)).branch.id

    const plan = await planBranchMerge(harness.db, childId, 'merge')
    expect(plan.plan.changes.map((change) => [change.action, change.label])).toEqual([['create', 'From the parent']])
    await applyBranchMerge(harness.db, { branchId: childId, direction: 'merge', resolutions: {}, actorUserId: null })
    expect((await getDataRow(harness.db, MAIN_SCOPE, 'parent-post'))!.cells.title).toBe('From the parent')
  })
})
