/**
 * Access rules and site import.
 *
 * An import must never open something that was limited to members:
 *  - a table's rule is a column the bundle's table writes do not set, and a
 *    `replace` deletes and recreates custom tables;
 *  - a page's rule is a cell, and the bundle's row replaces the cells.
 * A bundle can also carry table rules, which an import only ever adds.
 *
 * Runs on SQLite by default and on Postgres with
 * `DB=postgres TEST_POSTGRES_URL=...` (see `createTestDb`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { SiteBundle, ImportStrategy } from '@core/data/bundleSchema'
import type { AccessRule } from '@core/members'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { authorizeImportedTableAccess, recordImportedTableAccess } from '../../../server/handlers/cms/import'
import { applySiteBundle } from '../../../server/handlers/cms/importApply'
import type { AuthUser } from '../../../server/repositories/users'
import { resetForTests } from '../../../server/publish/renderCache'
import { createDataRow, getDataRow, listDataRows } from '../../../server/repositories/data'
import { getTableAccess, writeTableAccess } from '../../../server/repositories/data/tableAccess'
import { createDataTable, listDataTables } from '../../../server/repositories/data/tables'
import { createCapabilityTestHarness } from '../helpers/capabilityHarness'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

const MEMBERS: AccessRule = { level: 'members', onDeny: 'login' }
const PRO: AccessRule = { level: 'tags', tags: ['pro'], onDeny: 'login' }

let t: TestDb

/** The site as it stands, in the shape an export produces. */
async function currentBundle(): Promise<SiteBundle> {
  const tables = await listDataTables(t.db, MAIN_SCOPE)
  const rows = (await Promise.all(tables.map((table) => listDataRows(t.db, MAIN_SCOPE, table.id)))).flat()
  return { schemaVersion: 1, exportedAt: new Date(0).toISOString(), tables, rows }
}

function apply(bundle: SiteBundle, strategy: ImportStrategy, mayChangePageAccess = false) {
  return applySiteBundle(t.db, MAIN_SCOPE, { bundle, strategy, carriesMedia: false, mayChangePageAccess })
}

function withoutPageAccess(bundle: SiteBundle): SiteBundle {
  return {
    ...bundle,
    rows: bundle.rows.map((row) => {
      const { access: _dropped, ...cells } = row.cells
      return row.id === 'page_club' ? { ...row, cells } : row
    }),
  }
}

async function pageAccess(): Promise<unknown> {
  return (await getDataRow(t.db, MAIN_SCOPE, 'page_club'))?.cells.access
}

beforeEach(async () => {
  resetForTests()
  t = await createTestDb()
  // Postgres runs share one database, so start each case from a known state.
  await t.db`delete from data_rows`
  await t.db`delete from data_tables where system = ${false}`
  await t.db`update data_tables set access_json = ${null}`
  await t.db`delete from audit_events`
  await t.db`delete from users where id = 'admin_1'`
  await t.db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'owner')
  `
  await createDataTable(t.db, MAIN_SCOPE, {
    id: 'guides', name: 'Guides', slug: 'guides', kind: 'postType', routeBase: '/guides',
    singularLabel: 'Guide', pluralLabel: 'Guides',
  })
  await createDataRow(t.db, MAIN_SCOPE, { id: 'guide_1', tableId: 'guides', cells: { title: 'One', slug: 'one' }, slug: 'one' }, 'admin_1')
  await createDataRow(
    t.db,
    MAIN_SCOPE,
    { id: 'page_club', tableId: 'pages', cells: { title: 'Club', slug: 'club', access: MEMBERS }, slug: 'club' },
    'admin_1',
  )
})

afterEach(async () => {
  await t.cleanup()
})

describe('a table limited to members', () => {
  beforeEach(async () => {
    await writeTableAccess(t.db, 'guides', MEMBERS)
    await writeTableAccess(t.db, 'posts', PRO)
  })

  for (const strategy of ['replace', 'merge-add', 'merge-overwrite'] as const) {
    it(`stays limited after a ${strategy} import of a bundle that carries no rules`, async () => {
      await apply(await currentBundle(), strategy)
      expect(await getTableAccess(t.db, 'guides')).toEqual(MEMBERS)
      expect(await getTableAccess(t.db, 'posts')).toEqual(PRO)
    })
  }

  it('keeps its own rule when the bundle carries a different one', async () => {
    await apply({ ...(await currentBundle()), tableAccess: { guides: PRO } }, 'merge-overwrite')
    expect(await getTableAccess(t.db, 'guides')).toEqual(MEMBERS)
  })
})

describe('a bundle that carries table rules', () => {
  it('limits the tables it brings, on every strategy that writes them', async () => {
    const bundle: SiteBundle = { ...(await currentBundle()), tableAccess: { guides: MEMBERS, posts: PRO } }
    await apply(bundle, 'replace')
    expect(await getTableAccess(t.db, 'guides')).toEqual(MEMBERS)
    expect(await getTableAccess(t.db, 'posts')).toEqual(PRO)
  })

  it('adds a rule to an open table on merge-overwrite, and leaves it alone on merge-add', async () => {
    const bundle: SiteBundle = { ...(await currentBundle()), tableAccess: { guides: MEMBERS } }
    await apply(bundle, 'merge-add')
    expect((await getTableAccess(t.db, 'guides'))?.level).toBe('public')
    const applied = await apply(bundle, 'merge-overwrite')
    expect(await getTableAccess(t.db, 'guides')).toEqual(MEMBERS)
    expect(applied.tableAccessAdded).toEqual([{ tableId: 'guides', slug: 'guides' }])

    // The handlers write one audit event per table the import limited.
    await recordImportedTableAccess(new Request('http://localhost/admin/api/cms/import'), t.db, { id: 'admin_1' } as AuthUser, applied.tableAccessAdded)
    const { rows } = await t.db<{ action: string; target_id: string; metadata_json: Record<string, unknown> }>`
      select action, target_id, metadata_json from audit_events where action = 'data.table.access'
    `
    expect(rows.map((row) => [row.action, row.target_id, row.metadata_json.source])).toEqual([['data.table.access', 'guides', 'import']])
    expect((await apply(bundle, 'merge-overwrite')).tableAccessAdded).toEqual([])
  })

  it('limits a table that merge-add creates', async () => {
    const bundle = await currentBundle()
    const guides = bundle.tables.find((table) => table.id === 'guides')!
    await apply(
      { ...bundle, tables: [{ ...guides, id: 'notes', name: 'Notes', slug: 'notes', routeBase: '/notes' }], rows: [], tableAccess: { notes: PRO } },
      'merge-add',
    )
    expect(await getTableAccess(t.db, 'notes')).toEqual(PRO)
  })
})

describe('a page limited to members', () => {
  for (const strategy of ['replace', 'merge-overwrite'] as const) {
    it(`keeps its rule on ${strategy} when the importer may not change page access`, async () => {
      await apply(withoutPageAccess(await currentBundle()), strategy)
      expect(await pageAccess()).toEqual(MEMBERS)
    })

    it(`takes the bundle's value on ${strategy} when the importer may change page access`, async () => {
      await apply(withoutPageAccess(await currentBundle()), strategy, true)
      expect(await pageAccess()).toBeUndefined()
    })
  }

  it('is brought in with its rule by a bundle', async () => {
    const bundle = await currentBundle()
    await apply({ ...bundle, rows: bundle.rows.filter((row) => row.id !== 'page_club') }, 'replace', true)
    expect(await getDataRow(t.db, MAIN_SCOPE, 'page_club')).toBeNull()
    await apply(bundle, 'merge-add')
    expect(await pageAccess()).toEqual(MEMBERS)
  })
})

describe('a protected address', () => {
  it('keeps its rule when a different page takes the address', async () => {
    const bundle = await currentBundle()
    const club = bundle.rows.find((row) => row.id === 'page_club')!
    const { access: _dropped, ...cells } = club.cells
    await apply({ ...bundle, rows: [...bundle.rows.filter((row) => row !== club), { ...club, id: 'page_other', cells }] }, 'replace')
    expect((await getDataRow(t.db, MAIN_SCOPE, 'page_other'))?.cells.access).toEqual(MEMBERS)
  })

  it('keeps its rule when a different table takes the route', async () => {
    await writeTableAccess(t.db, 'guides', MEMBERS)
    const bundle = await currentBundle()
    await apply(
      {
        ...bundle,
        tables: bundle.tables.map((table) => (table.id === 'guides' ? { ...table, id: 'guides_new', slug: 'guides-new' } : table)),
        rows: bundle.rows.filter((row) => row.tableId !== 'guides'),
      },
      'replace',
    )
    expect(await getTableAccess(t.db, 'guides_new')).toEqual(MEMBERS)
  })

  it('keeps its rule in the published versions a bundle restores', async () => {
    const bundle = withoutPageAccess(await currentBundle())
    const stamp = new Date(0).toISOString()
    const publication = {
      snapshots: [{
        id: 'snap_1',
        site: { pages: [{ id: 'page_club', slug: 'club' }], visualComponents: [], layouts: [] },
        importmapBody: null,
        importmapSha256: null,
        createdAt: stamp,
      }],
      files: [],
      rows: [...bundle.rows.filter((row) => row.id !== 'page_club').map((row) => ({ rowId: row.id, activeVersionId: null, versions: [] })), {
        rowId: 'page_club',
        activeVersionId: 'ver_1',
        versions: [{
          id: 'ver_1', versionNumber: 1, cells: { title: 'Club', slug: 'club' }, slug: 'club',
          siteSnapshotId: 'snap_1', runtimeAssets: null, publishedAt: stamp, createdAt: stamp,
        }],
      }],
    }
    const published = {
      ...bundle,
      rows: bundle.rows.map((row) => (row.id === 'page_club' ? { ...row, status: 'published' as const, publishedAt: stamp } : row)),
      publication,
    } as unknown as SiteBundle
    await apply(published, 'merge-overwrite')
    const { rows } = await t.db<{ cells_json: Record<string, unknown> }>`select cells_json from data_row_versions where id = 'ver_1'`
    expect(rows[0]?.cells_json.access).toEqual(MEMBERS)
  })
})

describe('importing table rules', () => {
  const request = new Request('http://localhost/admin/api/cms/import', { method: 'POST' })
  const user = (capabilities: string[]) => ({ id: 'u', capabilities }) as unknown as AuthUser

  it('asks for the right to manage each limited table', async () => {
    const bundle = { ...(await currentBundle()), tableAccess: { guides: MEMBERS } }
    const denied = await authorizeImportedTableAccess(request, t.db, user(['data.import']), bundle)
    expect(denied?.status).toBe(403)
    const system = await authorizeImportedTableAccess(request, t.db, user(['data.import', 'data.custom.tables.manage']), { ...bundle, tableAccess: { posts: MEMBERS } })
    expect(system?.status).toBe(403)
  })

  it('refuses a tag nobody can be granted, and asks nothing of a bundle without rules', async () => {
    const bundle = await currentBundle()
    const reserved = await authorizeImportedTableAccess(request, t.db, user(['data.custom.tables.manage']), {
      ...bundle,
      tableAccess: { guides: { level: 'tags', tags: ['instatic:x'], onDeny: 'login' } },
    })
    expect(reserved?.status).toBe(400)
    expect(await authorizeImportedTableAccess(request, t.db, user([]), bundle)).toBeNull()
  })
})

describe('the import endpoint and a bundle that limits a table', () => {
  it('refuses an importer who may not manage the table, and asks the one who may to confirm', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const [posts] = (await listDataTables(harness.db, MAIN_SCOPE)).filter((table) => table.id === 'posts')
      const notes = { ...posts!, id: 'notes', name: 'Notes', slug: 'notes', routeBase: '/notes', system: false }
      const bundle = {
        schemaVersion: 1, exportedAt: new Date(0).toISOString(), tables: [notes], rows: [],
        tableAccess: { notes: MEMBERS },
      }
      const send = (cookie: string) =>
        harness.cms('/admin/api/cms/import?strategy=merge-add', { method: 'POST', cookie, json: bundle })

      const importer = await harness.createRoleUser({ name: 'Importer', slug: 'importer', capabilities: ['data.import'] })
      const refused = await send(importer.cookie)
      expect(refused.status).toBe(403)
      expect(((await refused.json()) as { error: string }).error).toBe('Importing table access rules requires permission to manage those tables')

      const manager = await harness.createRoleUser({
        name: 'Table manager', slug: 'table-manager', capabilities: ['data.import', 'data.custom.tables.manage'],
      })
      const asked = await send(manager.cookie)
      expect(asked.status).toBe(401)
      expect(((await asked.json()) as { error: string }).error).toBe('step_up_required')
      expect(await getTableAccess(harness.db, 'notes')).toBeNull()

      expect((await send(await harness.stepUp(manager.cookie))).status).toBe(200)
      expect(await getTableAccess(harness.db, 'notes')).toEqual(MEMBERS)
      const { rows } = await harness.db<{ target_id: string }>`select target_id from audit_events where action = 'data.table.access'`
      expect(rows.map((row) => row.target_id)).toEqual(['notes'])
    } finally {
      await harness.cleanup()
    }
  })
})
