import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../../../db/sqlite'
import { sqliteMigrations } from '../../../../db/migrations-sqlite'
import { runMigrations } from '../../../../db/runMigrations'
import type { DbClient } from '../../../../db/client'
import { reconcileDataRowRoster } from '../reconcile'

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

describe('reconcileDataRowRoster', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('lets a created row take the slug of a row reaped in the same batch (delete + recreate by name)', async () => {
    // The components scenario: delete VC "Button", create a new VC also named
    // "Button" — same derived slug — in one save.
    await seedRow(db, 'vc-old', 'button')
    const { reapedPublished } = await reconcileDataRowRoster(db, {
      tableId: 'components',
      writes: [{ id: 'vc-new', cells: { name: 'Button' }, slug: 'button' }],
      keepIds: new Set(['vc-new']),
      actorUserId: USER_ID,
    })
    expect(reapedPublished).toBe(false)

    const slugs = await activeSlugs(db)
    expect(slugs.get('vc-new')).toBe('button')
    expect(slugs.has('vc-old')).toBe(false)
  })

  it('handles a three-row slug rotation in one batch', async () => {
    // a→b→c→a: no in-place update order works without the placeholder pass.
    await seedRow(db, 'a', 'one')
    await seedRow(db, 'b', 'two')
    await seedRow(db, 'c', 'three')
    await reconcileDataRowRoster(db, {
      tableId: 'components',
      writes: [
        { id: 'a', cells: { name: 'a' }, slug: 'two' },
        { id: 'b', cells: { name: 'b' }, slug: 'three' },
        { id: 'c', cells: { name: 'c' }, slug: 'one' },
      ],
      keepIds: new Set(['a', 'b', 'c']),
      actorUserId: USER_ID,
    })

    const slugs = await activeSlugs(db)
    expect(slugs.get('a')).toBe('two')
    expect(slugs.get('b')).toBe('three')
    expect(slugs.get('c')).toBe('one')
  })

  it('reports whether a reaped row was published', async () => {
    await seedRow(db, 'pub', 'pub-slug', 'published')
    await seedRow(db, 'draft', 'draft-slug', 'draft')

    const first = await reconcileDataRowRoster(db, {
      tableId: 'components',
      writes: [],
      keepIds: new Set(['pub']),
      actorUserId: USER_ID,
    })
    expect(first.reapedPublished).toBe(false) // only the draft row was reaped

    const second = await reconcileDataRowRoster(db, {
      tableId: 'components',
      writes: [],
      keepIds: new Set<string>(),
      actorUserId: USER_ID,
    })
    expect(second.reapedPublished).toBe(true) // the published row went

    expect((await activeSlugs(db)).size).toBe(0)
  })

  it('revives a soft-deleted row when its id is re-submitted (undo of a delete)', async () => {
    await seedRow(db, 'vc-a', 'card')
    // Reap it…
    await reconcileDataRowRoster(db, {
      tableId: 'components',
      writes: [],
      keepIds: new Set<string>(),
      actorUserId: USER_ID,
    })
    expect((await activeSlugs(db)).has('vc-a')).toBe(false)

    // …then the client undoes the delete and saves the same id again. A
    // plain insert would hit the soft-deleted row's primary key.
    await reconcileDataRowRoster(db, {
      tableId: 'components',
      writes: [{ id: 'vc-a', cells: { name: 'Card v2' }, slug: 'card-v2' }],
      keepIds: new Set(['vc-a']),
      actorUserId: USER_ID,
    })

    const slugs = await activeSlugs(db)
    expect(slugs.get('vc-a')).toBe('card-v2')
  })

  it('respects the optimistic-concurrency baseline when reaping', async () => {
    await seedRow(db, 'known', 'known')
    await seedRow(db, 'sibling-created', 'sibling')

    await reconcileDataRowRoster(db, {
      tableId: 'components',
      writes: [],
      keepIds: new Set<string>(),
      baselineIds: new Set(['known']),
      actorUserId: USER_ID,
    })

    const slugs = await activeSlugs(db)
    expect(slugs.has('known')).toBe(false) // in baseline, dropped → reaped
    expect(slugs.has('sibling-created')).toBe(true) // never seen by this client → kept
  })
})
