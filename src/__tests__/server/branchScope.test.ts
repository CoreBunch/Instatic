import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import {
  BRANCH_HEADER,
  BRANCH_NOT_FOUND_CODE,
  MAIN_SCOPE,
  resolveBranchScope,
} from '../../../server/branches/scope'
import { insertBranch, listBranches } from '../../../server/repositories/branches'
import {
  createDataRow,
  getDataRow,
  listDataRows,
  listDataTables,
  getDataTable,
  saveDataRowDraft,
  softDeleteDataRow,
} from '../../../server/repositories/data'
import { insertDataTableIfAbsent } from '../../../server/repositories/data/tables'
import { getDraftSite, saveDraftSite } from '../../../server/repositories/site'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { createSite } from '../../../server/repositories/setup'

let testDb: TestDb

beforeAll(async () => {
  testDb = await createTestDb()
})

afterAll(async () => {
  await testDb.cleanup()
})

function request(header?: string): Request {
  return new Request('http://localhost/admin/api/cms/pages', {
    headers: header === undefined ? {} : { [BRANCH_HEADER]: header },
  })
}

describe('resolveBranchScope', () => {
  it('treats a missing or main header as main without touching the database', async () => {
    expect(await resolveBranchScope(request(), testDb.db)).toBe(MAIN_SCOPE)
    expect(await resolveBranchScope(request('main'), testDb.db)).toBe(MAIN_SCOPE)
    expect(await resolveBranchScope(request('  '), testDb.db)).toBe(MAIN_SCOPE)
  })

  it('rejects malformed ids before consulting the registry', async () => {
    const res = await resolveBranchScope(request('Not Valid'), testDb.db)
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(400)
  })

  it('answers 404 with a stable code for an unknown branch', async () => {
    const res = await resolveBranchScope(request('ghost'), testDb.db)
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(404)
    const body = await (res as Response).json()
    expect(body.code).toBe(BRANCH_NOT_FOUND_CODE)
  })

  it('resolves an existing branch', async () => {
    await insertBranch(testDb.db, {
      id: 'spring',
      name: 'Spring',
      baseBranchId: 'main',
      createdByUserId: null,
    })
    expect(await resolveBranchScope(request('spring'), testDb.db)).toEqual({ branchId: 'spring' })
    const branches = await listBranches(testDb.db)
    expect(branches.map((branch) => branch.id)).toEqual(['main', 'spring'])
  })
})

describe('branch-scoped repositories', () => {
  it('seeds every system table on main with its logical id', async () => {
    const tables = await listDataTables(testDb.db, MAIN_SCOPE)
    const ids = tables.map((table) => table.id)
    expect(ids).toContain('pages')
    expect(ids).toContain('posts')
    expect(ids).toContain('components')
    expect(ids).toContain('layouts')
    const { rows } = await testDb.db<{ id: string; logical_id: string; branch_id: string }>`
      select id, logical_id, branch_id from data_tables where logical_id = 'pages'
    `
    expect(rows).toEqual([{ id: 'pages', logical_id: 'pages', branch_id: 'main' }])
  })

  it('keeps a branch row invisible to main and exposes only logical ids', async () => {
    const spring = { branchId: 'spring' }
    const inserted = await insertDataTableIfAbsent(testDb.db, spring, {
      id: 'pages',
      name: 'Pages',
      slug: 'pages',
      kind: 'page',
      singularLabel: 'Page',
      pluralLabel: 'Pages',
    })
    expect(inserted).toBe(true)

    const created = await createDataRow(testDb.db, spring, {
      id: 'home',
      tableId: 'pages',
      cells: { title: 'Home', slug: 'index' },
      slug: 'index',
    })
    expect(created.id).toBe('home')
    expect(created.tableId).toBe('pages')

    const { rows } = await testDb.db<{ id: string; table_id: string; branch_id: string }>`
      select id, table_id, branch_id from data_rows where logical_id = 'home'
    `
    expect(rows).toEqual([{ id: 'spring:home', table_id: 'spring:pages', branch_id: 'spring' }])

    expect(await getDataRow(testDb.db, spring, 'home')).not.toBeNull()
    expect(await getDataRow(testDb.db, MAIN_SCOPE, 'home')).toBeNull()
    expect((await listDataRows(testDb.db, MAIN_SCOPE, 'pages')).map((row) => row.id)).not.toContain('home')
    expect((await listDataRows(testDb.db, spring, 'pages')).map((row) => row.id)).toEqual(['home'])
  })

  it('keeps one shell row per branch', async () => {
    await createSite(testDb.db, 'Main site', {})
    const main = await getDraftSite(testDb.db, MAIN_SCOPE)
    expect(main?.name).toBe('Main site')
    expect(await getDraftSite(testDb.db, { branchId: 'spring' })).toBeNull()

    await saveDraftSite(testDb.db, { branchId: 'spring' }, { ...main!, name: 'Spring site' })
    expect((await getDraftSite(testDb.db, { branchId: 'spring' }))?.name).toBe('Spring site')
    expect((await getDraftSite(testDb.db, MAIN_SCOPE))?.name).toBe('Main site')
    const { rows } = await testDb.db<{ id: string; branch_id: string; logical_id: string }>`
      select id, branch_id, logical_id from site order by id
    `
    expect(rows).toEqual([
      { id: 'default', branch_id: 'main', logical_id: 'default' },
      { id: 'spring:default', branch_id: 'spring', logical_id: 'default' },
    ])
  })
})

describe('physical ids never cross scopes', () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await createTestDb()
    await createSite(testDb.db, 'Main site', {})
  })

  afterEach(async () => {
    await testDb.cleanup()
  })

  it('refuses a branch row or table addressed by its physical id from main', async () => {
    const spring = { branchId: 'spring' }
    await insertBranch(testDb.db, { id: 'spring', name: 'Spring', baseBranchId: 'main', createdByUserId: null })
    await insertDataTableIfAbsent(testDb.db, spring, {
      id: 'pages',
      name: 'Pages',
      slug: 'pages',
      kind: 'page',
      singularLabel: 'Page',
      pluralLabel: 'Pages',
    })
    await createDataRow(testDb.db, spring, { id: 'home', tableId: 'pages', cells: { title: 'Spring home' }, slug: 'home' })

    expect(await getDataRow(testDb.db, MAIN_SCOPE, 'spring:home')).toBeNull()
    expect(await getDataTable(testDb.db, MAIN_SCOPE, 'spring:pages')).toBeNull()
    expect(await listDataRows(testDb.db, MAIN_SCOPE, 'spring:pages')).toEqual([])
    expect(await softDeleteDataRow(testDb.db, MAIN_SCOPE, 'spring:home')).toBeNull()
    expect(await saveDataRowDraft(testDb.db, MAIN_SCOPE, 'spring:home', { cells: { title: 'x' }, slug: 'home' })).toBeNull()
    // The branch still sees its row.
    expect((await getDataRow(testDb.db, spring, 'home'))?.cells.title).toBe('Spring home')
  })
})
