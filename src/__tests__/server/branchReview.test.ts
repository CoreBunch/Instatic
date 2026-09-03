/**
 * Merge review — site files as merge entities, per-change detail (fields,
 * page tree diffs, file text), the request/comment/decline lifecycle over
 * HTTP with its capability gates, and the before/after page render.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { applyBranchMerge, planBranchMerge } from '../../../server/branches/merge'
import { getDataRow, listDataRows, saveDataRowDraft, upsertDataRowDraft } from '../../../server/repositories/data'
import { getDraftSite, saveDraftSite } from '../../../server/repositories/site'
import {
  createCapabilityTestHarness,
  expectForbidden,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import type { SiteFile } from '@core/files/schemas'
import type { BranchMergeRequest, BranchReviewComment, BranchReviewState, MergePlan } from '@core/branches'

const BRANCHES = '/admin/api/cms/branches'

async function forkViaApi(harness: CapabilityTestHarness, owner: string, name: string): Promise<string> {
  const res = await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name } })
  expect(res.status).toBe(201)
  return (await readJson<{ branch: { id: string } }>(res)).branch.id
}

function themeFile(content: string, overrides: Partial<SiteFile> = {}): SiteFile {
  return {
    id: 'file-theme',
    path: 'src/styles/theme.css',
    type: 'style',
    content,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('merge review', () => {
  let harness: CapabilityTestHarness | null = null

  afterEach(async () => {
    await harness?.cleanup()
    harness = null
  })

  it('treats site files as their own entities: adds, merges, and conflicts per file', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const branchId = await forkViaApi(harness, owner, 'Files')
    const branch = { branchId }

    const shell = (await getDraftSite(harness.db, branch))!
    await saveDraftSite(harness.db, branch, { ...shell, files: [...shell.files, themeFile(':root { --brand: red; }')] })

    const created = await planBranchMerge(harness.db, branchId, 'merge')
    expect(created.plan.changes.map((change) => [change.kind, change.action, change.label])).toEqual([
      ['file', 'create', 'src/styles/theme.css'],
    ])
    const detail = created.plan.changes[0]!.detail
    expect(detail.kind).toBe('file')
    if (detail.kind === 'file') {
      expect(detail.before).toBeNull()
      expect(detail.after).toBe(':root { --brand: red; }')
      expect(detail.binary).toBe(false)
    }

    await applyBranchMerge(harness.db, { branchId, direction: 'merge', resolutions: {}, actorUserId: null })
    const mainShell = (await getDraftSite(harness.db, MAIN_SCOPE))!
    expect(mainShell.files.find((file) => file.id === 'file-theme')?.content).toBe(':root { --brand: red; }')
    expect((await planBranchMerge(harness.db, branchId, 'merge')).plan.changes).toEqual([])

    // Both sides edit the same file's content: one conflict, on that file only.
    const mainNow = (await getDraftSite(harness.db, MAIN_SCOPE))!
    await saveDraftSite(harness.db, MAIN_SCOPE, {
      ...mainNow,
      files: mainNow.files.map((file) => (file.id === 'file-theme' ? { ...file, content: ':root { --brand: blue; }' } : file)),
    })
    const branchNow = (await getDraftSite(harness.db, branch))!
    await saveDraftSite(harness.db, branch, {
      ...branchNow,
      files: branchNow.files.map((file) => (file.id === 'file-theme' ? { ...file, content: ':root { --brand: green; }' } : file)),
    })
    const conflicted = await planBranchMerge(harness.db, branchId, 'merge')
    expect(conflicted.plan.changes.map((change) => [change.kind, change.conflicts])).toEqual([['file', ['content']]])
    // The shell itself did not change — files are not part of its content any more.
    expect(conflicted.plan.changes.some((change) => change.kind === 'site')).toBe(false)

    await applyBranchMerge(harness.db, {
      branchId,
      direction: 'merge',
      resolutions: { 'file:file-theme': 'from' },
      actorUserId: null,
    })
    expect((await getDraftSite(harness.db, MAIN_SCOPE))!.files.find((file) => file.id === 'file-theme')?.content)
      .toBe(':root { --brand: green; }')

    // Removing the file on the branch removes it from main on merge.
    const afterMerge = (await getDraftSite(harness.db, branch))!
    await saveDraftSite(harness.db, branch, { ...afterMerge, files: afterMerge.files.filter((file) => file.id !== 'file-theme') })
    const removal = await planBranchMerge(harness.db, branchId, 'merge')
    expect(removal.plan.changes.map((change) => [change.kind, change.action])).toEqual([['file', 'delete']])
    await applyBranchMerge(harness.db, { branchId, direction: 'merge', resolutions: {}, actorUserId: null })
    expect((await getDraftSite(harness.db, MAIN_SCOPE))!.files.some((file) => file.id === 'file-theme')).toBe(false)
  })

  it('describes a page change as fields plus a node-level tree diff', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    // A node written outside the editor (no style maps at all) lives on main
    // before the fork; the branch stores it with the maps the editor adds.
    const shapeOnlyNodeId = 'review-shape-node'
    const [seed] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const seedBody = seed!.cells.body as { nodes: Record<string, Record<string, unknown>>; rootNodeId: string }
    await saveDataRowDraft(harness.db, MAIN_SCOPE, seed!.id, {
      cells: {
        ...seed!.cells,
        body: {
          ...seedBody,
          nodes: {
            ...seedBody.nodes,
            [shapeOnlyNodeId]: { id: shapeOnlyNodeId, moduleId: 'base.text', props: { text: 'Stays' }, children: [] },
          },
        },
      },
      slug: seed!.slug,
    })
    const branchId = await forkViaApi(harness, owner, 'Home copy')
    const branch = { branchId }

    const [home] = await listDataRows(harness.db, branch, 'pages')
    const body = home!.cells.body as { nodes: Record<string, Record<string, unknown>>; rootNodeId: string }
    const nodeIds = Object.keys(body.nodes).filter((id) => id !== shapeOnlyNodeId)
    expect(nodeIds.length).toBeGreaterThan(0)
    const changedNodeId = nodeIds[nodeIds.length - 1]!
    const addedNodeId = 'review-added-node'
    const nextNodes = {
      ...body.nodes,
      // Same node as the editor would load it: empty maps are not a change.
      [shapeOnlyNodeId]: { ...body.nodes[shapeOnlyNodeId]!, inlineStyles: {}, breakpointOverrides: {}, classIds: [] },
      [changedNodeId]: {
        ...body.nodes[changedNodeId]!,
        label: 'Reviewed block',
        props: { ...(body.nodes[changedNodeId]!.props as object), reviewed: true },
      },
      [addedNodeId]: { id: addedNodeId, moduleId: 'base.text', props: { text: 'Added on the branch' }, children: [] },
    }
    await saveDataRowDraft(harness.db, branch, home!.id, {
      cells: { ...home!.cells, title: 'Home, branch edition', body: { ...body, nodes: nextNodes } },
      slug: home!.slug,
    })

    const { plan } = await planBranchMerge(harness.db, branchId, 'merge')
    const change = plan.changes.find((entry) => entry.kind === 'row' && entry.logicalId === home!.id)!
    expect(change.detail.kind).toBe('row')
    if (change.detail.kind === 'row') {
      const title = change.detail.fields.find((field) => field.id === 'title')!
      expect(title.after).toBe('Home, branch edition')
      expect(title.before).toBe(home!.cells.title)
      // The tree is not shown as a JSON blob; it is a node diff.
      expect(change.detail.fields.some((field) => field.id === 'body')).toBe(false)
      expect(change.detail.tree).not.toBeNull()
      expect(change.detail.tree!.changed).toEqual([changedNodeId])
      expect(change.detail.tree!.added).toEqual([addedNodeId])
      expect(change.detail.tree!.removed).toEqual([])
      // Labels: the editor's node name when there is one, else the module.
      expect(change.detail.tree!.labels[changedNodeId]).toBe('Reviewed block')
      expect(change.detail.tree!.labels[addedNodeId]).toBe('text')
    }
  })

  it('runs the request, comment, decline, re-request and merge lifecycle with its gates', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const editor = await harness.createRoleUser({
      name: 'Branch editor',
      slug: 'branch-editor',
      capabilities: ['site.read', 'site.content.edit'],
    })
    const outsider = await harness.createRoleUser({
      name: 'No site access',
      slug: 'no-site',
      capabilities: ['dashboard.read'],
    })
    const branchId = await forkViaApi(harness, owner, 'Launch')
    const review = `${BRANCHES}/${branchId}/review`

    // Nothing yet: no request, no comments, a content hash.
    const empty = await readJson<BranchReviewState>(await harness.cms(review, { cookie: editor.cookie }))
    expect(empty.request).toBeNull()
    expect(empty.comments).toEqual([])
    expect(empty.contentHash).toHaveLength(64)
    await expectForbidden(await harness.cms(review, { cookie: outsider.cookie }))

    // The editor asks for a merge; a second open request is refused.
    const requested = await harness.cms(`${review}/request`, { method: 'POST', cookie: editor.cookie, json: { note: 'Launch page ready' } })
    expect(requested.status).toBe(201)
    const request = (await readJson<{ request: BranchMergeRequest }>(requested)).request
    expect(request.status).toBe('open')
    expect(request.note).toBe('Launch page ready')
    expect(request.requestedBy?.email).toBe(editor.email)
    expect(request.contentHash).toBe(empty.contentHash)
    expect((await harness.cms(`${review}/request`, { method: 'POST', cookie: editor.cookie, json: { note: 'again' } })).status).toBe(409)

    // Comments: editor on the request, owner on a change; outsiders cannot.
    const onRequest = await harness.cms(`${review}/comments`, { method: 'POST', cookie: editor.cookie, json: { entityKey: '', body: 'Please look at the hero.' } })
    expect(onRequest.status).toBe(201)
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const onPage = await harness.cms(`${review}/comments`, { method: 'POST', cookie: owner, json: { entityKey: `row:${home!.id}`, body: 'Headline is fine.' } })
    expect(onPage.status).toBe(201)
    const comment = (await readJson<{ comment: BranchReviewComment }>(onPage)).comment
    expect(comment.entityKey).toBe(`row:${home!.id}`)
    expect(comment.requestId).toBe(request.id)
    expect(comment.author?.gravatarHash).toHaveLength(64)
    await expectForbidden(await harness.cms(`${review}/comments`, { method: 'POST', cookie: outsider.cookie, json: { entityKey: '', body: 'hi' } }))
    expect((await harness.cms(`${review}/comments`, { method: 'POST', cookie: editor.cookie, json: { entityKey: '', body: '   ' } })).status).toBe(400)

    // Declining needs the manage capability and a note.
    await expectForbidden(await harness.cms(`${review}/decline`, { method: 'POST', cookie: editor.cookie, json: { note: 'no' } }))
    expect((await harness.cms(`${review}/decline`, { method: 'POST', cookie: owner, json: { note: '  ' } })).status).toBe(400)
    const declined = await harness.cms(`${review}/decline`, { method: 'POST', cookie: owner, json: { note: 'Fix the hero copy first.' } })
    expect(declined.status).toBe(200)
    expect((await readJson<{ request: BranchMergeRequest }>(declined)).request.status).toBe('declined')
    // Only one open request at a time, but a declined one can be followed by a new one.
    expect((await harness.cms(`${review}/decline`, { method: 'POST', cookie: owner, json: { note: 'twice' } })).status).toBe(409)
    const again = await harness.cms(`${review}/request`, { method: 'POST', cookie: editor.cookie, json: { note: 'Fixed.' } })
    expect(again.status).toBe(201)

    const state = await readJson<BranchReviewState>(await harness.cms(review, { cookie: owner }))
    expect(state.request?.status).toBe('open')
    expect(state.request?.note).toBe('Fixed.')
    expect(state.comments.map((entry) => entry.body)).toEqual(['Please look at the hero.', 'Headline is fine.'])

    // Withdraw: only the requester or a manager; then request once more.
    await expectForbidden(await harness.cms(`${review}/withdraw`, { method: 'POST', cookie: outsider.cookie }))
    const withdrawn = await harness.cms(`${review}/withdraw`, { method: 'POST', cookie: editor.cookie })
    expect(withdrawn.status).toBe(200)
    expect((await readJson<{ request: BranchMergeRequest }>(withdrawn)).request.status).toBe('withdrawn')
    expect((await harness.cms(`${review}/request`, { method: 'POST', cookie: editor.cookie, json: { note: 'Third time' } })).status).toBe(201)

    // A merge closes the open request as merged.
    const stepped = await harness.stepUp(owner)
    const merged = await harness.cms(`${BRANCHES}/${branchId}/merge`, { method: 'POST', cookie: stepped, json: { resolutions: {} } })
    expect(merged.status).toBe(200)
    // Step-up rotated the owner's session cookie; keep using the stepped one.
    const after = await readJson<BranchReviewState>(await harness.cms(review, { cookie: stepped }))
    expect(after.request?.status).toBe('merged')
    expect(after.request?.resolvedBy?.email).toBeDefined()
    // Timestamps are UTC ISO strings on both dialects (not SQLite's local-time text).
    const resolvedAt = Date.parse(after.request!.resolvedAt!)
    expect(Math.abs(Date.now() - resolvedAt)).toBeLessThan(60_000)
    expect(after.request!.resolvedAt).toMatch(/Z$/)
  })

  it('withholds rows of content tables the reader may not open, while pages stay readable', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    // site.read only: can review, but has no data-table read capability at all.
    const reader = await harness.createRoleUser({ name: 'Site reader', slug: 'site-reader', capabilities: ['site.read'] })
    const branchId = await forkViaApi(harness, owner, 'Redacted')
    const branch = { branchId }
    const [home] = await listDataRows(harness.db, branch, 'pages')
    await saveDataRowDraft(harness.db, branch, home!.id, { cells: { ...home!.cells, title: 'Secret title' }, slug: home!.slug })
    await upsertDataRowDraft(harness.db, branch, {
      id: 'secret-post',
      tableId: 'posts',
      cells: { title: 'Secret post', slug: 'secret-post' },
      slug: 'secret-post',
    })

    const { plan } = await readJson<{ plan: MergePlan }>(await harness.cms(`${BRANCHES}/${branchId}/merge`, { cookie: reader.cookie }))
    expect(plan.changes).toHaveLength(2)
    // Pages are the site: readable with site.read, rendered too.
    const page = plan.changes.find((change) => change.logicalId === home!.id)!
    expect(page.label).toBe('Secret title')
    const render = await harness.cms(`${BRANCHES}/${branchId}/review/render?row=${encodeURIComponent(home!.id)}&side=branch`, { cookie: reader.cookie })
    expect(render.status).toBe(200)
    // Posts follow the data workspace's gate: withheld from a site.read-only reader.
    const post = plan.changes.find((change) => change.logicalId === 'secret-post')!
    expect(post.label).toBe('A row you cannot read')
    expect(post.detail).toEqual({ kind: 'row', fields: [], tree: null })
    expect(JSON.stringify(plan)).not.toContain('Secret post')

    // The owner sees everything.
    const full = await readJson<{ plan: MergePlan }>(await harness.cms(`${BRANCHES}/${branchId}/merge`, { cookie: owner }))
    expect(full.plan.changes.map((change) => change.label)).toEqual(expect.arrayContaining(['Secret title', 'Secret post']))
  })

  it('refuses to merge a file whose path another file already uses, instead of dropping it', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const branchId = await forkViaApi(harness, owner, 'Collide')
    const branch = { branchId }
    // Main and the branch each add a file at the same path under different ids.
    const mainShell = (await getDraftSite(harness.db, MAIN_SCOPE))!
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...mainShell, files: [...mainShell.files, themeFile('main', { id: 'file-main' })] })
    const branchShell = (await getDraftSite(harness.db, branch))!
    await saveDraftSite(harness.db, branch, { ...branchShell, files: [...branchShell.files, themeFile('branch', { id: 'file-branch' })] })

    const { plan } = await planBranchMerge(harness.db, branchId, 'merge')
    const incoming = plan.changes.find((change) => change.key === 'file:file-branch')!
    expect(incoming.action).toBe('create')
    expect(incoming.conflicts).toEqual(['(path)'])
    // Keeping main's file is a valid decision; taking the branch's is refused, never silently lost.
    await expect(
      applyBranchMerge(harness.db, { branchId, direction: 'merge', resolutions: { 'file:file-branch': 'from' }, actorUserId: null }),
    ).rejects.toThrow(/already uses the path/)
    expect((await getDraftSite(harness.db, MAIN_SCOPE))!.files.filter((file) => file.path === 'src/styles/theme.css')).toHaveLength(1)
  })

  it('lets a reader load the plan and renders a page for either side with node ids', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const editor = await harness.createRoleUser({
      name: 'Reader',
      slug: 'reader',
      capabilities: ['site.read'],
    })
    const branchId = await forkViaApi(harness, owner, 'Render')
    const branch = { branchId }
    const [home] = await listDataRows(harness.db, branch, 'pages')
    await saveDataRowDraft(harness.db, branch, home!.id, {
      cells: { ...home!.cells, title: 'Rendered on the branch' },
      slug: home!.slug,
    })

    // The plan is readable by anyone who can read the site (the review needs it).
    const planRes = await harness.cms(`${BRANCHES}/${branchId}/merge`, { cookie: editor.cookie })
    expect(planRes.status).toBe(200)
    const { plan } = await readJson<{ plan: MergePlan }>(planRes)
    expect(plan.changes.map((change) => change.logicalId)).toContain(home!.id)

    const render = `${BRANCHES}/${branchId}/review/render`
    const branchSide = await harness.cms(`${render}?row=${encodeURIComponent(home!.id)}&side=branch`, { cookie: editor.cookie })
    expect(branchSide.status).toBe(200)
    // Served as text so a direct navigation never runs it as a page.
    expect(branchSide.headers.get('content-type')).toContain('text/plain')
    expect(branchSide.headers.get('content-security-policy')).toBe('sandbox')
    expect(branchSide.headers.get('cache-control')).toBe('no-store')
    const branchHtml = await branchSide.text()
    expect(branchHtml).toContain('<title>Rendered on the branch')
    const rootNodeId = (home!.cells.body as { rootNodeId: string }).rootNodeId
    const nodeIds = Object.keys((home!.cells.body as { nodes: Record<string, unknown> }).nodes).filter((id) => id !== rootNodeId)
    // Every rendered node carries its id for the review's highlights.
    for (const id of nodeIds.slice(0, 3)) expect(branchHtml).toContain(`uid="${id}"`)

    const mainSide = await harness.cms(`${render}?row=${encodeURIComponent(home!.id)}&side=main`, { cookie: editor.cookie })
    expect(mainSide.status).toBe(200)
    expect(await mainSide.text()).not.toContain('Rendered on the branch')

    expect((await harness.cms(`${render}?row=missing&side=main`, { cookie: editor.cookie })).status).toBe(404)
    expect((await harness.cms(`${render}?row=${encodeURIComponent(home!.id)}&side=elsewhere`, { cookie: editor.cookie })).status).toBe(400)
    const stranger = await harness.createRoleUser({ name: 'Stranger', slug: 'stranger', capabilities: ['dashboard.read'] })
    await expectForbidden(await harness.cms(`${render}?row=${encodeURIComponent(home!.id)}&side=main`, { cookie: stranger.cookie }))
  })
})
