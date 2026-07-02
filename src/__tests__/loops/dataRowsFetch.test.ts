/**
 * Behavior tests for `fetchPublishedDataRowItems` — the `data.rows` loop
 * source's page-slice query — against a real migrated SQLite database.
 *
 * Locks in, for BOTH table kinds (post-type published-version join and
 * data-kind direct read):
 *   - every orderBy × direction combination's row order,
 *   - the publishedAt → createdAt mapping on data-kind tables,
 *   - status / soft-delete filtering,
 *   - pagination (limit/offset) with a stable totalItems,
 *   - the LoopItem fields projection (identity, people, media aliases,
 *     dates, permalink),
 *   - fallback behavior for unknown orderBy / direction / tableId.
 *
 * Written alongside the refactor that collapsed the per-order-branch SQL
 * into one query + a whitelisted ORDER BY map, to pin the query semantics
 * independent of how the SQL text is assembled.
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { createUser } from '../../../server/repositories/users'
import { fetchPublishedDataRowItems } from '@core/loops/sources/dataRows'

type Db = TestDb['db']

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

interface PostSeed {
  rowId: string
  slug: string
  cells: Record<string, unknown>
  status?: 'draft' | 'published'
  deletedAt?: string | null
  authorUserId?: string | null
  publishedByUserId?: string | null
  versionPublishedAt: string
  versionCreatedAt: string
  rowUpdatedAt: string
}

/**
 * Insert a `posts` row + version pair. `data_rows.active_version_id` and
 * `data_row_versions.row_id` form a circular FK, so: row first (no active
 * version), then the version, then point the row at it.
 */
async function seedPost(db: Db, seed: PostSeed): Promise<void> {
  const versionId = `${seed.rowId}-v1`
  await db`
    insert into data_rows
      (id, table_id, cells_json, slug, status, author_user_id, updated_at, deleted_at)
    values
      (${seed.rowId}, ${'posts'}, ${JSON.stringify(seed.cells)}, ${seed.slug},
       ${seed.status ?? 'published'}, ${seed.authorUserId ?? null},
       ${seed.rowUpdatedAt}, ${seed.deletedAt ?? null})
  `
  await db`
    insert into data_row_versions
      (id, row_id, version_number, cells_json, slug, published_by_user_id, published_at, created_at)
    values
      (${versionId}, ${seed.rowId}, ${1}, ${JSON.stringify(seed.cells)}, ${seed.slug},
       ${seed.publishedByUserId ?? null}, ${seed.versionPublishedAt}, ${seed.versionCreatedAt})
  `
  await db`update data_rows set active_version_id = ${versionId} where id = ${seed.rowId}`
}

interface DataRowSeed {
  rowId: string
  slug: string
  cells: Record<string, unknown>
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
}

/** Insert a data-kind row — no version workflow, live on creation. */
async function seedDataRow(db: Db, tableId: string, seed: DataRowSeed): Promise<void> {
  await db`
    insert into data_rows
      (id, table_id, cells_json, slug, status, created_at, updated_at, deleted_at)
    values
      (${seed.rowId}, ${tableId}, ${JSON.stringify(seed.cells)}, ${seed.slug},
       ${'draft'}, ${seed.createdAt}, ${seed.updatedAt}, ${seed.deletedAt ?? null})
  `
}

async function fetchSlugs(
  db: Db,
  tableId: string,
  orderBy: string,
  direction: 'asc' | 'desc',
): Promise<string[]> {
  const { items } = await fetchPublishedDataRowItems(db, {
    tableId,
    orderBy,
    direction,
    limit: 50,
    offset: 0,
  })
  return items.map((item) => String(item.fields['slug']))
}

// ---------------------------------------------------------------------------
// Shared fixture — one DB for the whole suite (read-only after seeding)
// ---------------------------------------------------------------------------

let testDb: TestDb
let db: Db
let authorId: string
let publisherId: string

beforeAll(async () => {
  testDb = await createTestDb()
  db = testDb.db

  const author = await createUser(db, {
    email: 'author@example.com',
    displayName: 'Ada Author',
    passwordHash: 'h-author',
    roleId: 'admin',
  })
  const publisher = await createUser(db, {
    email: 'publisher@example.com',
    displayName: 'Percy Publisher',
    passwordHash: 'h-publisher',
    roleId: 'client',
  })
  authorId = author.id
  publisherId = publisher.id

  // Featured-media asset referenced by the 'alpha' post's cells.
  await db`
    insert into media_assets
      (id, filename, mime_type, size_bytes, storage_path, public_path,
       storage_adapter_id, externally_hosted)
    values ('m1', 'hero.png', 'image/png', 100, 'hero.png', '/uploads/hero.png', '', 0)
  `

  // Post-type rows: distinct publishedAt / createdAt / updatedAt / slug
  // orderings so each orderBy option produces a different sequence.
  await seedPost(db, {
    rowId: 'row-alpha',
    slug: 'alpha',
    cells: {
      title: 'Alpha',
      body: 'Intro\n\n![inline](/uploads/inline.png)\n',
      featuredMedia: 'm1',
    },
    authorUserId: authorId,
    publishedByUserId: publisherId,
    versionPublishedAt: '2026-01-03T00:00:00.000Z',
    versionCreatedAt: '2026-01-01T00:00:00.000Z',
    rowUpdatedAt: '2026-01-02T00:00:00.000Z',
  })
  await seedPost(db, {
    rowId: 'row-bravo',
    slug: 'bravo',
    cells: { title: 'Bravo' },
    versionPublishedAt: '2026-01-01T00:00:00.000Z',
    versionCreatedAt: '2026-01-03T00:00:00.000Z',
    rowUpdatedAt: '2026-01-01T00:00:00.000Z',
  })
  await seedPost(db, {
    rowId: 'row-charlie',
    slug: 'charlie',
    cells: { title: 'Charlie' },
    versionPublishedAt: '2026-01-02T00:00:00.000Z',
    versionCreatedAt: '2026-01-02T00:00:00.000Z',
    rowUpdatedAt: '2026-01-03T00:00:00.000Z',
  })
  // Excluded: draft status (has an active version — proves the status filter,
  // not just the join, excludes it).
  await seedPost(db, {
    rowId: 'row-delta',
    slug: 'delta',
    cells: { title: 'Delta' },
    status: 'draft',
    versionPublishedAt: '2026-01-04T00:00:00.000Z',
    versionCreatedAt: '2026-01-04T00:00:00.000Z',
    rowUpdatedAt: '2026-01-04T00:00:00.000Z',
  })
  // Excluded: soft-deleted despite published status.
  await seedPost(db, {
    rowId: 'row-echo',
    slug: 'echo',
    cells: { title: 'Echo' },
    deletedAt: '2026-01-05T00:00:00.000Z',
    versionPublishedAt: '2026-01-05T00:00:00.000Z',
    versionCreatedAt: '2026-01-05T00:00:00.000Z',
    rowUpdatedAt: '2026-01-05T00:00:00.000Z',
  })

  // Data-kind table + rows. Status stays 'draft' (the default) on every row —
  // data-kind iteration ignores the publish lifecycle entirely.
  await db`
    insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label)
    values ('things', 'Things', 'things', 'data', '/things', 'Thing', 'Things')
  `
  await seedDataRow(db, 'things', {
    rowId: 'thing-x',
    slug: 'x',
    cells: { name: 'X' },
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-03T00:00:00.000Z',
  })
  await seedDataRow(db, 'things', {
    rowId: 'thing-y',
    slug: 'y',
    cells: { name: 'Y' },
    createdAt: '2026-02-03T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  })
  await seedDataRow(db, 'things', {
    rowId: 'thing-z',
    slug: 'z',
    cells: { name: 'Z' },
    createdAt: '2026-02-02T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
  })
  await seedDataRow(db, 'things', {
    rowId: 'thing-w',
    slug: 'w',
    cells: { name: 'W' },
    createdAt: '2026-02-04T00:00:00.000Z',
    updatedAt: '2026-02-04T00:00:00.000Z',
    deletedAt: '2026-02-05T00:00:00.000Z',
  })
})

afterAll(async () => {
  await testDb.cleanup()
})

// ---------------------------------------------------------------------------
// Post-type tables — published-version join
// ---------------------------------------------------------------------------

describe('fetchPublishedDataRowItems — post-type ordering', () => {
  it('orders by publishedAt in both directions (version published_at)', async () => {
    expect(await fetchSlugs(db, 'posts', 'publishedAt', 'asc')).toEqual(['bravo', 'charlie', 'alpha'])
    expect(await fetchSlugs(db, 'posts', 'publishedAt', 'desc')).toEqual(['alpha', 'charlie', 'bravo'])
  })

  it('orders by createdAt in both directions (version created_at)', async () => {
    expect(await fetchSlugs(db, 'posts', 'createdAt', 'asc')).toEqual(['alpha', 'charlie', 'bravo'])
    expect(await fetchSlugs(db, 'posts', 'createdAt', 'desc')).toEqual(['bravo', 'charlie', 'alpha'])
  })

  it('orders by updatedAt in both directions (row updated_at)', async () => {
    expect(await fetchSlugs(db, 'posts', 'updatedAt', 'asc')).toEqual(['bravo', 'alpha', 'charlie'])
    expect(await fetchSlugs(db, 'posts', 'updatedAt', 'desc')).toEqual(['charlie', 'alpha', 'bravo'])
  })

  it('orders by slug in both directions (version slug)', async () => {
    expect(await fetchSlugs(db, 'posts', 'slug', 'asc')).toEqual(['alpha', 'bravo', 'charlie'])
    expect(await fetchSlugs(db, 'posts', 'slug', 'desc')).toEqual(['charlie', 'bravo', 'alpha'])
  })

  it('falls back to publishedAt / desc for unknown orderBy and direction', async () => {
    const { items } = await fetchPublishedDataRowItems(db, {
      tableId: 'posts',
      orderBy: 'title', // not a whitelisted order column
      direction: 'sideways' as never,
      limit: 50,
      offset: 0,
    })
    expect(items.map((i) => i.fields['slug'])).toEqual(['alpha', 'charlie', 'bravo'])
  })

  it('excludes draft and soft-deleted rows from items and totalItems', async () => {
    const { items, totalItems } = await fetchPublishedDataRowItems(db, {
      tableId: 'posts',
      orderBy: 'slug',
      direction: 'asc',
      limit: 50,
      offset: 0,
    })
    const slugs = items.map((i) => i.fields['slug'])
    expect(slugs).not.toContain('delta')
    expect(slugs).not.toContain('echo')
    expect(totalItems).toBe(3)
  })

  it('paginates with limit/offset while totalItems stays the full count', async () => {
    const first = await fetchPublishedDataRowItems(db, {
      tableId: 'posts',
      orderBy: 'publishedAt',
      direction: 'desc',
      limit: 2,
      offset: 0,
    })
    expect(first.items.map((i) => i.fields['slug'])).toEqual(['alpha', 'charlie'])
    expect(first.totalItems).toBe(3)

    const rest = await fetchPublishedDataRowItems(db, {
      tableId: 'posts',
      orderBy: 'publishedAt',
      direction: 'desc',
      limit: 2,
      offset: 2,
    })
    expect(rest.items.map((i) => i.fields['slug'])).toEqual(['bravo'])
    expect(rest.totalItems).toBe(3)
  })

  it('projects the full LoopItem field surface', async () => {
    const { items } = await fetchPublishedDataRowItems(db, {
      tableId: 'posts',
      orderBy: 'slug',
      direction: 'asc',
      limit: 1,
      offset: 0,
    })
    const alpha = items[0]!
    expect(alpha.id).toBe('row-alpha')

    const f = alpha.fields
    // Identity + cells
    expect(f['id']).toBe('row-alpha')
    expect(f['rowId']).toBe('row-alpha')
    expect(f['versionId']).toBe('row-alpha-v1')
    expect(f['versionNumber']).toBe(1)
    expect(f['tableId']).toBe('posts')
    expect(f['tableSlug']).toBe('posts')
    expect(f['title']).toBe('Alpha')
    // People
    expect(f['authorName']).toBe('Ada Author')
    expect(f['authorRoleSlug']).toBe('admin')
    expect(f['publishedByName']).toBe('Percy Publisher')
    expect(f['publishedByRoleSlug']).toBe('client')
    // Media aliases — featured resolves through media_assets, first image
    // comes from the body markdown.
    expect(f['featuredMediaId']).toBe('m1')
    expect(f['featuredMedia']).toBe('/uploads/hero.png')
    expect(f['featuredMediaPath']).toBe('/uploads/hero.png')
    expect(f['featuredMediaUrl']).toBe('/uploads/hero.png')
    expect(f['firstImage']).toBe('/uploads/inline.png')
    // Dates + routing
    expect(f['slug']).toBe('alpha')
    expect(f['publishedAt']).toBe('2026-01-03T00:00:00.000Z')
    expect(f['createdAt']).toBe('2026-01-01T00:00:00.000Z')
    expect(f['updatedAt']).toBe('2026-01-02T00:00:00.000Z')
    expect(f['permalink']).toBe('/posts/alpha')
  })
})

// ---------------------------------------------------------------------------
// Data-kind tables — direct data_rows read
// ---------------------------------------------------------------------------

describe('fetchPublishedDataRowItems — data-kind ordering', () => {
  it('maps publishedAt to createdAt (no publish lifecycle)', async () => {
    expect(await fetchSlugs(db, 'things', 'publishedAt', 'asc')).toEqual(['x', 'z', 'y'])
    expect(await fetchSlugs(db, 'things', 'publishedAt', 'desc')).toEqual(['y', 'z', 'x'])
  })

  it('orders by createdAt / updatedAt / slug in both directions', async () => {
    expect(await fetchSlugs(db, 'things', 'createdAt', 'asc')).toEqual(['x', 'z', 'y'])
    expect(await fetchSlugs(db, 'things', 'createdAt', 'desc')).toEqual(['y', 'z', 'x'])
    expect(await fetchSlugs(db, 'things', 'updatedAt', 'asc')).toEqual(['y', 'z', 'x'])
    expect(await fetchSlugs(db, 'things', 'updatedAt', 'desc')).toEqual(['x', 'z', 'y'])
    expect(await fetchSlugs(db, 'things', 'slug', 'asc')).toEqual(['x', 'y', 'z'])
    expect(await fetchSlugs(db, 'things', 'slug', 'desc')).toEqual(['z', 'y', 'x'])
  })

  it('includes draft-status rows but excludes soft-deleted rows', async () => {
    const { items, totalItems } = await fetchPublishedDataRowItems(db, {
      tableId: 'things',
      orderBy: 'slug',
      direction: 'asc',
      limit: 50,
      offset: 0,
    })
    // All seeded rows have status 'draft' — they still iterate.
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.fields['slug'])).not.toContain('w')
    expect(totalItems).toBe(3)
  })

  it('projects data-kind fields: permalink base, createdAt-as-publishedAt, null publisher', async () => {
    const { items } = await fetchPublishedDataRowItems(db, {
      tableId: 'things',
      orderBy: 'slug',
      direction: 'asc',
      limit: 1,
      offset: 0,
    })
    const x = items[0]!
    expect(x.id).toBe('thing-x')
    const f = x.fields
    expect(f['name']).toBe('X')
    expect(f['permalink']).toBe('/things/x')
    expect(f['publishedAt']).toBe('2026-02-01T00:00:00.000Z')
    expect(f['createdAt']).toBe('2026-02-01T00:00:00.000Z')
    expect(f['updatedAt']).toBe('2026-02-03T00:00:00.000Z')
    expect(f['publishedBy']).toBeNull()
    expect(f['publishedByName']).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------

describe('fetchPublishedDataRowItems — degenerate inputs', () => {
  it('returns empty for an empty tableId', async () => {
    const result = await fetchPublishedDataRowItems(db, {
      tableId: '',
      orderBy: 'publishedAt',
      direction: 'desc',
      limit: 50,
      offset: 0,
    })
    expect(result).toEqual({ items: [], totalItems: 0 })
  })

  it('returns empty for a tableId that does not exist', async () => {
    const result = await fetchPublishedDataRowItems(db, {
      tableId: 'nope',
      orderBy: 'publishedAt',
      direction: 'desc',
      limit: 50,
      offset: 0,
    })
    expect(result).toEqual({ items: [], totalItems: 0 })
  })
})
