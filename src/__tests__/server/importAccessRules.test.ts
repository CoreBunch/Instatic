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
import { applySiteBundle } from '../../../server/handlers/cms/importApply'
import { resetForTests } from '../../../server/publish/renderCache'
import { createDataRow, getDataRow, listDataRows } from '../../../server/repositories/data'
import { getTableAccess, writeTableAccess } from '../../../server/repositories/data/tableAccess'
import { createDataTable, listDataTables } from '../../../server/repositories/data/tables'
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
    await apply(bundle, 'merge-overwrite')
    expect(await getTableAccess(t.db, 'guides')).toEqual(MEMBERS)
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
