import { afterEach, describe, expect, it } from 'bun:test'
import type { DbResult } from '../../../server/db'
import { pgMigrations } from '../../../server/db/migrations-pg'
import {
  listDataTables,
  createDataTable,
  updateDataTable,
  createDataRow,
  listDataAuthorOptions,
  getPublishedDataRowByRoute,
  getDataRowRedirectByRoute,
} from '../../../server/repositories/data'
import { handleServerRequest } from '../../../server/router'
import { resetForTests } from '../../../server/publish/renderCache'
import { createFakeDb } from './dbTestFake'

import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import type { DbClient } from '../../../server/db/client'
import { publishDataRow } from '../../../server/publish/publishRow'
import { createUser } from '../../../server/repositories/users'

const clients: DbClient[] = []
afterEach(async () => { for (const db of clients.splice(0)) await db.close() })
async function realDb() {
  const db = createSqliteClient(':memory:'); clients.push(db)
  await runMigrations(db, sqliteMigrations)
  return db
}

type QueryHandler = (sql: string, params: unknown[]) => DbResult | undefined

function makeDataFakeDb(handlers: QueryHandler[]) {
  return createFakeDb(async (rawSql, params): Promise<DbResult> => {
    const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase()
    for (const handler of handlers) {
      const result = handler(sql, params)
      if (result) return result
    }
    throw new Error(`Unhandled SQL: ${rawSql}`)
  })
}

function rowDate(value: string) {
  return new Date(value)
}

const defaultFields = [
  { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
  { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: true },
  { type: 'richText', id: 'body', label: 'Body', format: 'markdown', builtIn: true },
  { type: 'media', id: 'featuredMedia', label: 'Featured media', mediaKind: 'image', builtIn: true },
  { type: 'text', id: 'seoTitle', label: 'SEO title', builtIn: true },
  { type: 'longText', id: 'seoDescription', label: 'SEO description', builtIn: true },
]

describe('data CMS migrations', () => {
  it('creates data tables and seeds the default Posts table', () => {
    const sql = pgMigrations.map((migration) => migration.sql).join('\n')

    expect(sql).toContain('create table if not exists data_tables')
    expect(sql).toContain('create table if not exists data_rows')
    expect(sql).toContain('create table if not exists data_row_versions')
    expect(sql).toContain('active_version_id')
    expect(sql).toContain('create table if not exists data_row_redirects')
    expect(sql).toContain("insert into data_tables")
  })
})

describe('data CMS repository', () => {
  it('lists data tables with frontend field names', async () => {
    const db = makeDataFakeDb([
      (sql) => {
        if (!sql.startsWith('select id, name, slug, kind, route_base')) return undefined
        return {
          rows: [{
            id: 'posts',
            name: 'Posts',
            slug: 'posts',
            kind: 'postType',
            route_base: '/posts',
            singular_label: 'Post',
            plural_label: 'Posts',
            primary_field_id: 'title',
            fields_json: defaultFields,
            created_by_user_id: null,
            updated_by_user_id: null,
            created_at: rowDate('2026-05-01T10:00:00Z'),
            updated_at: rowDate('2026-05-01T10:00:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(listDataTables(db)).resolves.toEqual([{
      id: 'posts',
      name: 'Posts',
      slug: 'posts',
      kind: 'postType',
      routeBase: '/posts',
      singularLabel: 'Post',
      pluralLabel: 'Posts',
      primaryFieldId: 'title',
      fields: defaultFields,
      system: false,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
    }])
  })

  it('creates a post-type table without creating a template page row', async () => {
    const db = makeDataFakeDb([
      (sql, params) => {
        if (!sql.startsWith('insert into data_tables')) return undefined
        expect(String(params[0])).toBeTruthy() // id (nanoid)
        expect(params[1]).toBe('Products')
        expect(params[2]).toBe('products')
        return {
          rows: [{
            id: 'products',
            name: 'Products',
            slug: 'products',
            kind: 'postType',
            route_base: '/products',
            singular_label: 'Product',
            plural_label: 'Products',
            primary_field_id: 'title',
            fields_json: defaultFields,
            created_by_user_id: null,
            updated_by_user_id: null,
            created_at: rowDate('2026-05-01T10:00:00Z'),
            updated_at: rowDate('2026-05-01T10:00:00Z'),
          }],
          rowCount: 1,
        }
      },
      (sql) => {
        if (sql.startsWith('insert into data_rows')) {
          throw new Error('createDataTable must not create page rows')
        }
        return undefined
      },
    ])

    const table = await createDataTable(db, {
      name: 'Products',
      slug: 'products',
      kind: 'postType',
      routeBase: '/products',
      singularLabel: 'Product',
      pluralLabel: 'Products',
      primaryFieldId: 'title',
      fields: defaultFields,
    })
    expect(table).toMatchObject({
      id: 'products',
      name: 'Products',
      slug: 'products',
      fields: defaultFields,
    })
  })

  it('updates table identity, route, labels, and field settings without losing locale paths', async () => {
    const db = await realDb()
    const table = await createDataTable(db, { id: 'products', name: 'Products', slug: 'products', kind: 'postType', routeBase: '/products', singularLabel: 'Product', pluralLabel: 'Products', fields: defaultFields })
    const nextFields = defaultFields.slice(0, 2)
    expect(await updateDataTable(db, table.id, { name: 'Catalog', slug: 'catalog', routeBase: '/catalog', singularLabel: 'Product', pluralLabel: 'Catalog', fields: nextFields }, null)).toMatchObject({
      id: 'products', name: 'Catalog', slug: 'catalog', routeBase: '/catalog', fields: nextFields,
    })
  })

  it('lists active data authors with role display metadata', async () => {
    const db = makeDataFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select users.id')) return undefined
        expect(sql).toContain('users.status = $1')
        expect(params).toEqual(['active'])
        return {
          rows: [{
            id: 'author_1',
            email: 'author@example.com',
            email_normalized: 'author@example.com',
            display_name: 'Author Name',
            password_hash: 'hash',
            status: 'active',
            role_id: 'editor',
            last_login_at: null,
            created_at: rowDate('2026-05-01T10:00:00Z'),
            updated_at: rowDate('2026-05-01T10:00:00Z'),
            deleted_at: null,
            role_slug: 'editor',
            role_name: 'Editor',
            role_description: '',
            role_is_system: true,
            role_capabilities_json: ['content.edit.own'],
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(listDataAuthorOptions(db)).resolves.toEqual([{
      id: 'author_1',
      email: 'author@example.com',
      displayName: 'Author Name',
      roleSlug: 'editor',
      roleName: 'Editor',
    }])
  })

  it('resolves the active published version by table route and row slug', async () => {
    const db = makeDataFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select data_row_versions.id')) return undefined
        expect(sql).toContain('data_row_versions.id = variants.active_version_id')
        expect(sql).toContain('data_row_versions.locale_id = variants.locale_id')
        expect(params).toEqual(['default', '/posts/hello', true])
        return {
          rows: [{
            id: 'version_1',
            row_id: 'row_1',
            locale_id: 'default',
            public_path: '/posts/hello',
            site_snapshot_id: null,
            table_id: 'posts',
            table_slug: 'posts',
            table_kind: 'postType',
            table_route_base: '/posts',
            version_number: 2,
            cells_json: {
              title: 'Published Hello',
              slug: 'hello',
              body: 'Published body',
              featuredMedia: null,
              seoTitle: 'SEO',
              seoDescription: 'Description',
            },
            slug: 'hello',
            author_user_id: 'author_1',
            author_display_name: 'Author Name',
            author_role_slug: 'editor',
            author_role_name: 'Editor',
            published_by_user_id: 'publisher_1',
            published_by_display_name: 'Publisher Name',
            published_by_role_slug: 'admin',
            published_by_role_name: 'Admin',
            published_at: rowDate('2026-05-01T10:02:00Z'),
            created_at: rowDate('2026-05-01T10:02:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(getPublishedDataRowByRoute(db, '/posts', 'hello', 'default')).resolves.toMatchObject({
      id: 'version_1',
      rowId: 'row_1',
      tableSlug: 'posts',
      tableRouteBase: '/posts',
      versionNumber: 2,
      slug: 'hello',
      authorUserId: 'author_1',
      authorName: 'Author Name',
      publishedByUserId: 'publisher_1',
      publishedByName: 'Publisher Name',
    })
  })

  it('does not resolve rows with non-matching published slugs', async () => {
    const db = makeDataFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select data_row_versions.id')) return undefined
        expect(params).toEqual(['default', '/posts/untitled', true])
        return { rows: [], rowCount: 0 }
      },
    ])

    await expect(getPublishedDataRowByRoute(db, '/posts', 'untitled', 'default')).resolves.toBeNull()
  })

  it('resolves old published slugs as redirects to the active published slug', async () => {
    const db = makeDataFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select redirects.id')) return undefined
        expect(params).toEqual(['/posts', 'untitled', true])
        return {
          rows: [{
            id: 'redirect_1',
            from_route_base: '/posts',
            from_slug: 'untitled',
            target_path: '/posts/post',
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(getDataRowRedirectByRoute(db, '/posts', 'untitled')).resolves.toEqual({
      id: 'redirect_1',
      fromPath: '/posts/untitled',
      targetPath: '/posts/post',
    })
  })
})

describe('data CMS public routes', () => {
  it('returns 404 when a published postType variant has no matching entry template', async () => {
    resetForTests()
    const db = await realDb()
    await db`insert into site (id, name, settings_json) values ('default', 'Test', ${{}})`
    await createUser(db, { id: 'owner', email: 'owner@example.test', displayName: 'Owner', passwordHash: 'fixture', roleId: 'owner', allowOwnerRole: true })
    await createDataTable(db, { id: 'products', name: 'Products', slug: 'products', kind: 'postType', routeBase: '/products', singularLabel: 'Product', pluralLabel: 'Products' })
    const row = await createDataRow(db, { tableId: 'products', cells: { title: 'Some product', slug: 'some-product', body: 'Product body' }, slug: 'some-product' })
    const result = await publishDataRow(db, row.id, null)
    expect(result.row.status).toBe('published')
    expect(result.version.publicPath).toBeNull()
    const res = await handleServerRequest(new Request('http://localhost/products/some-product'), { db })
    expect(res.status).toBe(404)
  })
})
