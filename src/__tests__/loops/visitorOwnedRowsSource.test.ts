/**
 * Integration tests for the `visitor.owned-rows` loop source — the per-visitor
 * owned-data iteration (Use-case B of the visitor-data framework).
 *
 * Mirrors the `dataRowsFetch.test.ts` harness (`createTestDb()` with every
 * migration applied, including migration `026` which adds
 * `data_rows.visitor_user_id`). The load-bearing contract pinned here is the
 * IDOR isolation rule: the source reads the visitor id ONLY from
 * `ctx.visitor.id` (cookie-derived) and filters `data_rows.visitor_user_id`
 * against it, so a visitor can never read another visitor's rows — even when
 * both visitors own rows in the same table.
 *
 * Seeding mirrors `seedDataRow` from the data-rows harness but adds the
 * `visitor_user_id` column; the rows belong to real `visitor_users` rows
 * (FK with ON DELETE SET NULL), so two visitor accounts are created up front.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { VisitorOwnedRowsSource } from '@core/loops/sources/visitorOwnedRows'

type Db = TestDb['db']

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

/**
 * Insert a `visitor_users` row directly. Mirrors the migration `021` columns
 * (`id, email, email_normalized, password_hash, display_name, role_id,
 * status`). The system `member` role is seeded by migration `021`, so we
 * reuse it as the role_id.
 */
async function seedVisitorUser(
  db: Db,
  input: {
    id: string
    email: string
    displayName: string
  },
): Promise<void> {
  await db`
    insert into visitor_users (id, email, email_normalized, password_hash, display_name, role_id, status)
    values (${input.id}, ${input.email}, ${input.email}, 'h', ${input.displayName}, 'member', 'active')
  `
}

interface OwnedRowSeed {
  rowId: string
  tableId: string
  slug: string
  cells: Record<string, unknown>
  visitorUserId: string
  createdAt: string
  updatedAt: string
}

/**
 * Insert a data-kind row owned by a visitor. Mirrors `seedDataRow` from the
 * data-rows harness but adds the `visitor_user_id` column (migration `026`).
 */
async function seedOwnedRow(db: Db, seed: OwnedRowSeed): Promise<void> {
  await db`
    insert into data_rows
      (id, table_id, cells_json, slug, status, created_at, updated_at, visitor_user_id)
    values
      (${seed.rowId}, ${seed.tableId}, ${JSON.stringify(seed.cells)}, ${seed.slug},
       'draft', ${seed.createdAt}, ${seed.updatedAt}, ${seed.visitorUserId})
  `
}

/**
 * Build a `SourceFetchContext`-shaped object for the owned-rows source. The
 * test DB satisfies `LoopSourceDb` (it exposes `unsafe` + `dialect`), and
 * `ctx.visitor.id` is the IDOR load-bearing input — cast `as any` to satisfy
 * the type without importing internal helpers.
 */
function makeCtx(db: Db, overrides: Record<string, unknown> = {}): any {
  return {
    db,
    site: {},
    filters: { tableId: 'things' },
    orderBy: 'createdAt',
    direction: 'asc',
    limit: 50,
    offset: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

let testDb: TestDb
let db: Db

const VISITOR_A = 'visitor-a'
const VISITOR_B = 'visitor-b'

beforeAll(async () => {
  testDb = await createTestDb()
  db = testDb.db

  await seedVisitorUser(db, { id: VISITOR_A, email: 'a@example.com', displayName: 'Visitor A' })
  await seedVisitorUser(db, { id: VISITOR_B, email: 'b@example.com', displayName: 'Visitor B' })

  // Primary data-kind table — 3 rows: 2 owned by visitorA, 1 by visitorB
  // (the IDOR double-visitor seed).
  await db`
    insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label)
    values ('things', 'Things', 'things', 'data', '/things', 'Thing', 'Things')
  `
  await seedOwnedRow(db, {
    rowId: 'thing-a1',
    tableId: 'things',
    slug: 'a1',
    cells: { title: 'A1', owner: 'A' },
    visitorUserId: VISITOR_A,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
  })
  await seedOwnedRow(db, {
    rowId: 'thing-a2',
    tableId: 'things',
    slug: 'a2',
    cells: { title: 'A2', owner: 'A' },
    visitorUserId: VISITOR_A,
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-03T00:00:00.000Z',
  })
  // The row visitorA must NOT see — owned by visitorB in the same table.
  await seedOwnedRow(db, {
    rowId: 'thing-b1',
    tableId: 'things',
    slug: 'b1',
    cells: { title: 'B1', owner: 'B' },
    visitorUserId: VISITOR_B,
    createdAt: '2026-03-03T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z',
  })

  // Second data-kind table with a visitorA-owned row — proves ctx.filters.tableId
  // scoping excludes rows from other tables.
  await db`
    insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label)
    values ('other', 'Other', 'other', 'data', '/other', 'Other', 'Others')
  `
  await seedOwnedRow(db, {
    rowId: 'other-a1',
    tableId: 'other',
    slug: 'oa1',
    cells: { title: 'OA1' },
    visitorUserId: VISITOR_A,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-02T00:00:00.000Z',
  })
})

afterAll(async () => {
  await testDb.cleanup()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('visitor.owned-rows loop source', () => {
  it('declares its id, per-visitor classification, tableId filter, and order options', () => {
    expect(VisitorOwnedRowsSource.id).toBe('visitor.owned-rows')
    expect(VisitorOwnedRowsSource.perVisitor).toBe(true)

    // tableId filter for scoping to a specific data table.
    expect(VisitorOwnedRowsSource.filterSchema).toHaveProperty('tableId')

    // Order options include createdAt / updatedAt / slug.
    const orderIds = VisitorOwnedRowsSource.orderByOptions.map((o) => o.id)
    expect(orderIds).toContain('createdAt')
    expect(orderIds).toContain('updatedAt')
    expect(orderIds).toContain('slug')
  })

  it('returns EXACTLY visitorA\'s rows and NEVER visitorB\'s (IDOR isolation)', async () => {
    const result = await VisitorOwnedRowsSource.fetch(
      makeCtx(db, {
        visitor: {
          id: VISITOR_A,
          displayName: 'Visitor A',
          email: 'a@example.com',
          roleName: 'member',
          profileFields: {},
        },
      }),
    )

    expect(result.totalItems).toBe(2)
    const ids = result.items.map((i) => i.id)
    expect(ids).toContain('thing-a1')
    expect(ids).toContain('thing-a2')
    // visitorB's row must never leak through, even though it lives in the
    // same table — the visitor_user_id filter is bound from ctx.visitor.id.
    expect(ids).not.toContain('thing-b1')
  })

  it('renders nothing for an anonymous request (no ctx.visitor)', async () => {
    const result = await VisitorOwnedRowsSource.fetch(makeCtx(db, { visitor: undefined }))
    expect(result).toEqual({ items: [], totalItems: 0 })
  })

  it('honours ctx.filters.tableId — rows from a different table are excluded', async () => {
    // Fetch the OTHER table → only that table's visitorA row, never the
    // 'things' rows.
    const otherResult = await VisitorOwnedRowsSource.fetch(
      makeCtx(db, {
        filters: { tableId: 'other' },
        visitor: {
          id: VISITOR_A,
          displayName: 'Visitor A',
          email: 'a@example.com',
          roleName: 'member',
          profileFields: {},
        },
      }),
    )
    expect(otherResult.totalItems).toBe(1)
    expect(otherResult.items.map((i) => i.id)).toEqual(['other-a1'])

    // And the default 'things' table fetch never returns the 'other' row.
    const thingsResult = await VisitorOwnedRowsSource.fetch(
      makeCtx(db, {
        visitor: {
          id: VISITOR_A,
          displayName: 'Visitor A',
          email: 'a@example.com',
          roleName: 'member',
          profileFields: {},
        },
      }),
    )
    expect(thingsResult.items.map((i) => i.id)).not.toContain('other-a1')
  })

  it('honours limit/offset while totalItems stays the full owned count', async () => {
    const visitorA = {
      id: VISITOR_A,
      displayName: 'Visitor A',
      email: 'a@example.com',
      roleName: 'member',
      profileFields: {},
    }

    const first = await VisitorOwnedRowsSource.fetch(
      makeCtx(db, { visitor: visitorA, limit: 1, offset: 0, orderBy: 'createdAt', direction: 'asc' }),
    )
    expect(first.items).toHaveLength(1)
    expect(first.items[0]!.id).toBe('thing-a1') // earliest createdAt first
    expect(first.totalItems).toBe(2)

    const rest = await VisitorOwnedRowsSource.fetch(
      makeCtx(db, { visitor: visitorA, limit: 1, offset: 1, orderBy: 'createdAt', direction: 'asc' }),
    )
    expect(rest.items).toHaveLength(1)
    expect(rest.items[0]!.id).toBe('thing-a2')
    expect(rest.totalItems).toBe(2) // stable total across pages
  })
})
