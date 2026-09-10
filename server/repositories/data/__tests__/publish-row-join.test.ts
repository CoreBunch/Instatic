import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { nanoid } from 'nanoid'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import type { DbClient } from '../../../db/client'
import { createUser } from '../../users'
import { getPublishedDataRowByRoute } from '../publish'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  return db
}

describe('getPublishedDataRowByRoute — author/publisher join parity', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  afterEach(async () => { await db.close() })

  it('resolves author + publisher fields from the shared user-ref joins', async () => {
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

    const rowId = nanoid()
    const versionId = nanoid()

    // Insert logical identity, immutable localized version and active variant.
    // The publisher join targets
    // data_row_versions.published_by_user_id, so we deliberately set a DIFFERENT
    // user on data_rows.published_by_user_id to prove the read pulls the
    // per-version publisher, not the row-level one.
    await db`
      insert into data_rows
        (id, table_id, cells_json, slug, status, author_user_id, published_by_user_id)
      values (${rowId}, ${'posts'}, ${'{}'}, ${'hello-world'}, ${'published'}, ${author.id}, ${author.id})
    `
    await db`
      insert into data_row_versions (id, row_id, version_number, cells_json, slug, published_by_user_id, locale_id, public_path)
      values (${versionId}, ${rowId}, ${1}, ${'{}'}, ${'hello-world'}, ${publisher.id}, ${'default'}, ${'/posts/hello-world'})
    `
    await db`insert into data_row_localizations (row_id, locale_id, active_version_id, availability)
      values (${rowId}, 'default', ${versionId}, 'online')`

    const published = await getPublishedDataRowByRoute(db, '/posts', 'hello-world')

    expect(published).not.toBeNull()
    expect(published!.rowId).toBe(rowId)
    expect(published!.tableSlug).toBe('posts')
    expect(published!.tableKind).toBe('postType')
    expect(published!.tableRouteBase).toBe('/posts')

    // Author fields come from data_rows.author_user_id.
    expect(published!.authorUserId).toBe(author.id)
    expect(published!.authorName).toBe('Ada Author')
    expect(published!.authorRoleSlug).toBe('admin')
    expect(published!.authorRoleName).toBe('Admin')

    // Publisher fields come from data_row_versions.published_by_user_id.
    expect(published!.publishedByUserId).toBe(publisher.id)
    expect(published!.publishedByName).toBe('Percy Publisher')
    expect(published!.publishedByRoleSlug).toBe('client')
    expect(published!.publishedByRoleName).toBe('Client')
  })

  it('returns null author/publisher refs when the row has no user attribution', async () => {
    const rowId = nanoid()
    const versionId = nanoid()
    await db`
      insert into data_rows
        (id, table_id, cells_json, slug, status, author_user_id, published_by_user_id)
      values (${rowId}, ${'posts'}, ${'{}'}, ${'anon'}, ${'published'}, ${null}, ${null})
    `
    await db`
      insert into data_row_versions (id, row_id, version_number, cells_json, slug, published_by_user_id, locale_id, public_path)
      values (${versionId}, ${rowId}, ${1}, ${'{}'}, ${'anon'}, ${null}, ${'default'}, ${'/posts/anon'})
    `
    await db`insert into data_row_localizations (row_id, locale_id, active_version_id, availability)
      values (${rowId}, 'default', ${versionId}, 'online')`

    const published = await getPublishedDataRowByRoute(db, '/posts', 'anon')

    expect(published).not.toBeNull()
    expect(published!.authorUserId).toBeNull()
    expect(published!.authorName).toBeNull()
    expect(published!.authorRoleSlug).toBeNull()
    expect(published!.publishedByUserId).toBeNull()
    expect(published!.publishedByName).toBeNull()
    expect(published!.publishedByRoleSlug).toBeNull()
  })
})
