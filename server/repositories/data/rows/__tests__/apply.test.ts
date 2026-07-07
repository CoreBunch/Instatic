import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../../../db/sqlite'
import { sqliteMigrations } from '../../../../db/migrations-sqlite'
import { runMigrations } from '../../../../db/runMigrations'
import type { DbClient } from '../../../../db/client'
import { applyDataRowChanges } from '../apply'
import { allocateSiteSeq } from '../../../syncSequence'

const USER_ID = 'user-owner'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, status, role_id)
    values (${USER_ID}, ${'owner@example.com'}, ${'owner@example.com'}, ${'Owner'}, ${'x'}, ${'active'}, ${'owner'})
  `
  return db
}

async function seedRow(db: DbClient, id: string, slug: string, status = 'draft'): Promise<void> {
  await db`
    insert into data_rows (id, table_id, cells_json, slug, status, author_user_id, created_by_user_id, updated_by_user_id)
    values (${id}, ${'components'}, ${{ name: id }}, ${slug}, ${status}, ${USER_ID}, ${USER_ID}, ${USER_ID})
  `
}

async function activeSlugs(db: DbClient): Promise<Map<string, string>> {
  const { rows } = await db<{ id: string; slug: string }>`
    select id, slug from data_rows
    where table_id = ${'components'} and deleted_at is null
  `
  return new Map(rows.map((r) => [r.id, r.slug]))
}

async function rowSeq(db: DbClient, id: string): Promise<number> {
  const { rows } = await db<{ seq: number }>`
    select seq from data_rows where id = ${id}
  `
  return Number(rows[0]?.seq ?? -1)
}

describe('applyDataRowChanges', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('lets a created row take the slug of a row deleted in the same batch (delete + recreate by name)', async () => {
    // The components scenario: delete VC "Button", create a new VC also named
    // "Button" — same derived slug — in one save.
    await seedRow(db, 'vc-old', 'button')
    const { deletedPublished } = await applyDataRowChanges(db, {
      tableId: 'components',
      writes: [{ id: 'vc-new', cells: { name: 'Button' }, slug: 'button' }],
      deleteIds: new Set(['vc-old']),
      actorUserId: USER_ID,
      seq: 1,
    })
    expect(deletedPublished).toBe(false)

    const slugs = await activeSlugs(db)
    expect(slugs.get('vc-new')).toBe('button')
    expect(slugs.has('vc-old')).toBe(false)
  })

  it('handles a three-row slug rotation in one batch', async () => {
    // a→b→c→a: no in-place update order works without the placeholder pass.
    await seedRow(db, 'a', 'one')
    await seedRow(db, 'b', 'two')
    await seedRow(db, 'c', 'three')
    await applyDataRowChanges(db, {
      tableId: 'components',
      writes: [
        { id: 'a', cells: { name: 'a' }, slug: 'two' },
        { id: 'b', cells: { name: 'b' }, slug: 'three' },
        { id: 'c', cells: { name: 'c' }, slug: 'one' },
      ],
      deleteIds: new Set<string>(),
      actorUserId: USER_ID,
      seq: 1,
    })

    const slugs = await activeSlugs(db)
    expect(slugs.get('a')).toBe('two')
    expect(slugs.get('b')).toBe('three')
    expect(slugs.get('c')).toBe('one')
  })

  it('reports whether a deleted row was published', async () => {
    await seedRow(db, 'pub', 'pub-slug', 'published')
    await seedRow(db, 'draft', 'draft-slug', 'draft')

    const first = await applyDataRowChanges(db, {
      tableId: 'components',
      writes: [],
      deleteIds: new Set(['draft']),
      actorUserId: USER_ID,
      seq: 1,
    })
    expect(first.deletedPublished).toBe(false)

    const second = await applyDataRowChanges(db, {
      tableId: 'components',
      writes: [],
      deleteIds: new Set(['pub']),
      actorUserId: USER_ID,
      seq: 2,
    })
    expect(second.deletedPublished).toBe(true)

    expect((await activeSlugs(db)).size).toBe(0)
  })

  it('revives a soft-deleted row when its id is re-submitted (undo of a delete)', async () => {
    await seedRow(db, 'vc-a', 'card')
    await applyDataRowChanges(db, {
      tableId: 'components',
      writes: [],
      deleteIds: new Set(['vc-a']),
      actorUserId: USER_ID,
      seq: 1,
    })
    expect((await activeSlugs(db)).has('vc-a')).toBe(false)

    // …then the client undoes the delete and saves the same id again. A
    // plain insert would hit the soft-deleted row's primary key.
    await applyDataRowChanges(db, {
      tableId: 'components',
      writes: [{ id: 'vc-a', cells: { name: 'Card v2' }, slug: 'card-v2' }],
      deleteIds: new Set<string>(),
      actorUserId: USER_ID,
      seq: 2,
    })

    const slugs = await activeSlugs(db)
    expect(slugs.get('vc-a')).toBe('card-v2')
  })

  it('never touches rows it was not told about — deletion is explicit intent', async () => {
    // The regression the explicit-delete protocol exists for: a stale client
    // that never learned about a sibling session's row cannot delete it,
    // because deletion-by-omission no longer exists.
    await seedRow(db, 'known', 'known')
    await seedRow(db, 'sibling-created', 'sibling')

    await applyDataRowChanges(db, {
      tableId: 'components',
      writes: [{ id: 'known', cells: { name: 'known v2' }, slug: 'known' }],
      deleteIds: new Set<string>(),
      actorUserId: USER_ID,
      seq: 1,
    })

    const slugs = await activeSlugs(db)
    expect(slugs.has('known')).toBe(true)
    expect(slugs.has('sibling-created')).toBe(true) // untouched — never mentioned
  })

  it('deleting an unknown or already-deleted id is an idempotent no-op', async () => {
    await seedRow(db, 'vc-a', 'card')
    const first = await applyDataRowChanges(db, {
      tableId: 'components',
      writes: [],
      deleteIds: new Set(['vc-a', 'never-existed']),
      actorUserId: USER_ID,
      seq: 1,
    })
    expect(first.deletedPublished).toBe(false)

    // Re-shipping the same delete (retry after a failed save) is harmless.
    const second = await applyDataRowChanges(db, {
      tableId: 'components',
      writes: [],
      deleteIds: new Set(['vc-a']),
      actorUserId: USER_ID,
      seq: 2,
    })
    expect(second.deletedPublished).toBe(false)
  })

  it('stamps the save seq on written AND soft-deleted rows', async () => {
    await seedRow(db, 'keep', 'keep')
    await seedRow(db, 'gone', 'gone')

    await applyDataRowChanges(db, {
      tableId: 'components',
      writes: [
        { id: 'keep', cells: { name: 'keep v2' }, slug: 'keep' },
        { id: 'fresh', cells: { name: 'fresh' }, slug: 'fresh' },
      ],
      deleteIds: new Set(['gone']),
      actorUserId: USER_ID,
      seq: 7,
    })

    expect(await rowSeq(db, 'keep')).toBe(7)   // updated in place
    expect(await rowSeq(db, 'fresh')).toBe(7)  // created
    expect(await rowSeq(db, 'gone')).toBe(7)   // soft-deleted rows are stamped too
  })
})

describe('allocateSiteSeq', () => {
  it('returns strictly increasing values from the counter row', async () => {
    const db = await freshDb()
    const a = await allocateSiteSeq(db)
    const b = await allocateSiteSeq(db)
    const c = await allocateSiteSeq(db)
    expect(a).toBe(1)
    expect(b).toBe(2)
    expect(c).toBe(3)
  })
})

describe('applyDataRowChanges — table scoping', () => {
  it('never soft-deletes a row belonging to ANOTHER table', async () => {
    const db = await freshDb()
    // A row in the seeded `posts` table — a crafted components delete list
    // naming it must not touch it.
    await db`
      insert into data_rows (id, table_id, cells_json, slug, status)
      values ('post-row', 'posts', ${{ title: 'Post' }}, 'a-post', 'published')
    `
    await seedRow(db, 'vc-a', 'card')

    const { deletedPublished } = await applyDataRowChanges(db, {
      tableId: 'components',
      writes: [],
      deleteIds: new Set(['post-row', 'vc-a']),
      actorUserId: USER_ID,
      seq: 1,
    })
    // The foreign-table id was skipped — not counted as a published deletion.
    expect(deletedPublished).toBe(false)

    const { rows } = await db<{ id: string; deleted_at: string | null }>`
      select id, deleted_at from data_rows where id in ('post-row', 'vc-a')
    `
    const byId = new Map(rows.map((r) => [r.id, r.deleted_at]))
    expect(byId.get('post-row')).toBeNull()      // untouched
    expect(byId.get('vc-a')).not.toBeNull()      // same-table delete applied
  })
})
