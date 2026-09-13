/**
 * Version history — listing a row's published versions and restoring one
 * into the draft on the request's branch.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { getDataRow, listDataRows, saveDataRowDraft } from '../../../server/repositories/data'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

const ROWS = '/admin/api/cms/data/rows'

describe('row version history', () => {
  let harness: CapabilityTestHarness | null = null

  afterEach(async () => {
    await harness?.cleanup()
    harness = null
  })

  it('lists published versions and restores one into the draft, on main and on a branch', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    expect(home).toBeDefined()

    const empty = await readJson<{ versions: unknown[] }>(
      await harness.cms(`${ROWS}/${home!.id}/versions`, { cookie: owner }),
    )
    expect(empty.versions).toEqual([])

    await saveDataRowDraft(harness.db, MAIN_SCOPE, home!.id, { cells: { ...home!.cells, title: 'First' }, slug: home!.slug })
    expect((await harness.cms(`${ROWS}/${home!.id}/publish`, { method: 'POST', cookie: owner })).status).toBe(200)
    await saveDataRowDraft(harness.db, MAIN_SCOPE, home!.id, { cells: { ...home!.cells, title: 'Second' }, slug: home!.slug })
    expect((await harness.cms(`${ROWS}/${home!.id}/publish`, { method: 'POST', cookie: owner })).status).toBe(200)

    const listed = await readJson<{ versions: Array<{ id: string; versionNumber: number; publishedByName: string | null }> }>(
      await harness.cms(`${ROWS}/${home!.id}/versions`, { cookie: owner }),
    )
    expect(listed.versions.map((version) => version.versionNumber)).toEqual([2, 1])
    expect(listed.versions[0]!.publishedByName).toBeTruthy()
    const first = listed.versions[1]!

    // Restore v1 into main's draft.
    const restored = await harness.cms(`${ROWS}/${home!.id}/versions/${first.id}/restore`, { method: 'POST', cookie: owner })
    expect(restored.status).toBe(200)
    expect((await readJson<{ row: { cells: Record<string, unknown> } }>(restored)).row.cells.title).toBe('First')
    expect((await getDataRow(harness.db, MAIN_SCOPE, home!.id))!.cells.title).toBe('First')

    // Restore v2 into a branch's draft without touching main.
    const fork = await harness.cms('/admin/api/cms/branches', { method: 'POST', cookie: owner, json: { name: 'History' } })
    expect(fork.status).toBe(201)
    const second = listed.versions[0]!
    const onBranch = await harness.cms(`${ROWS}/${home!.id}/versions/${second.id}/restore`, {
      method: 'POST',
      cookie: owner,
      headers: { 'x-instatic-branch': 'history' },
    })
    expect(onBranch.status).toBe(200)
    expect((await getDataRow(harness.db, { branchId: 'history' }, home!.id))!.cells.title).toBe('Second')
    expect((await getDataRow(harness.db, MAIN_SCOPE, home!.id))!.cells.title).toBe('First')

    // An unknown or foreign version id is a 404.
    const missing = await harness.cms(`${ROWS}/${home!.id}/versions/nope/restore`, { method: 'POST', cookie: owner })
    expect(missing.status).toBe(404)
  })
})
