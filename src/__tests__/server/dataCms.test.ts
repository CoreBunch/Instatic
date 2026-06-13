import { describe, expect, it } from 'bun:test'
import type { DbResult } from '../../../server/db'
import { pgMigrations } from '../../../server/db/migrations-pg'
import {
  listDataTables,
  createDataTable,
  updateDataTable,
  createDataRow,
  listDataAuthorOptions,
  updateDataRowAuthor,
  saveDataRowDraft,
  getPublishedDataRowByRoute,
  getDataRowRedirectByRoute,
} from '../../../server/repositories/data'
import { ensureDefaultEntryTemplate } from '../../../server/publish/templateSeeding'
import { handleServerRequest } from '../../../server/router'
import { resetForTests } from '../../../server/publish/renderCache'
import { createFakeDb } from './dbTestFake'

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

  it('creates a data table, then seeds its default entry template', async () => {
    // `createDataTable` is pure data access; the seeding orchestration is a
    // separate explicit call (`ensureDefaultEntryTemplate`) made by every
    // table-creation entry point. This test exercises both in sequence.
    // Tracks rows the template-seeding path inserts so we can return
    // shaped responses to `select` queries that follow.
    let seededPageRow: { id: string; cells: Record<string, unknown>; slug: string } | null = null

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
      // The explicit `ensureDefaultEntryTemplate` call below triggers the
      // default-entry-template seeding. The seeding helper:
      //   1. lists existing page rows to check whether a template already
      //      targets this table's slug (returns empty → none exist),
      //   2. picks an available slug (`<slug>-template`),
      //   3. inserts a draft data_row,
      //   4. re-reads the row,
      //   5. transactions a publishDataRow which writes a data_row_version,
      //      updates the data_row to status=published, and reads the
      //      previous-published-route + version-number.
      (sql) => {
        // Step 1: existence check.
        if (sql.startsWith("select cells_json from data_rows") && sql.includes("table_id = 'pages'")) {
          return { rows: [], rowCount: 0 }
        }
        return undefined
      },
      (sql) => {
        // Step 2: slug collision check.
        if (sql.startsWith('select id from data_rows') && sql.includes('and slug = ')) {
          return { rows: [], rowCount: 0 }
        }
        return undefined
      },
      (sql, params) => {
        // Step 3: insert seeded page row.
        if (sql.startsWith('insert into data_rows')) {
          seededPageRow = {
            id: String(params[0]),
            cells: params[2] as Record<string, unknown>,
            slug: String(params[3]),
          }
          return { rows: [{ id: seededPageRow.id }], rowCount: 1 }
        }
        return undefined
      },
      (sql, params) => {
        // Steps 4 / re-read after insert + publish: getDataRow.
        if (sql.startsWith('select') && sql.includes('from data_rows') && sql.includes('left join') && seededPageRow) {
          if (String(params[0]) !== seededPageRow.id) return undefined
          return {
            rows: [{
              id: seededPageRow.id,
              table_id: 'pages',
              cells_json: seededPageRow.cells,
              slug: seededPageRow.slug,
              status: 'draft',
              author_user_id: null,
              author_name: null,
              author_role_slug: null,
              author_role_name: null,
              created_by_user_id: null,
              updated_by_user_id: null,
              published_by_user_id: null,
              published_by_name: null,
              published_by_role_slug: null,
              published_by_role_name: null,
              published_at: null,
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:00:00Z'),
              active_version_id: null,
              scheduled_publish_at: null,
            }],
            rowCount: 1,
          }
        }
        return undefined
      },
      (sql) => {
        // Step 5: publishDataRow's previous-route lookup (returns empty
        // since this is the first publish), version-number max, version
        // insert, status update.
        if (sql.startsWith('select data_row_versions.slug as previous_slug')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.startsWith('select coalesce(max(version_number)')) {
          return { rows: [{ next: 1 }], rowCount: 1 }
        }
        if (sql.startsWith('insert into data_row_versions')) {
          return { rows: [], rowCount: 1 }
        }
        if (sql.startsWith('update data_rows') && sql.includes("set status = 'published'")) {
          return { rows: [{ id: seededPageRow?.id ?? '' }], rowCount: 1 }
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

    // createDataTable is data access only — no seeding side-effect yet.
    expect(seededPageRow).toBeNull()

    // Every table-creation entry point follows up with the seeding call.
    await ensureDefaultEntryTemplate(db, table, null)

    // Verify the seeding side-effect actually ran: a template page row
    // got inserted with the right template config.
    expect(seededPageRow).not.toBeNull()
    const cells = (seededPageRow as unknown as { cells: Record<string, unknown> } | null)?.cells ?? {}
    expect(cells.templateEnabled).toBe(true)
    expect(cells.templateTarget).toEqual({ kind: 'postTypes', tableSlugs: ['products'] })
  })

  it('updates table identity, route, labels, and field settings', async () => {
    const nextFields = defaultFields.slice(0, 2)
    const db = makeDataFakeDb([
      (sql, params) => {
        if (!sql.startsWith('update data_tables')) return undefined
        expect(params).toContain('Catalog')
        expect(params).toContain('catalog')
        return {
          rows: [{
            id: 'products',
            name: 'Catalog',
            slug: 'catalog',
            kind: 'postType',
            route_base: '/catalog',
            singular_label: 'Product',
            plural_label: 'Catalog',
            primary_field_id: 'title',
            fields_json: nextFields,
            created_by_user_id: null,
            updated_by_user_id: null,
            created_at: rowDate('2026-05-01T10:00:00Z'),
            updated_at: rowDate('2026-05-01T10:05:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(updateDataTable(db, 'products', {
      name: 'Catalog',
      slug: 'catalog',
      routeBase: '/catalog',
      singularLabel: 'Product',
      pluralLabel: 'Catalog',
      fields: nextFields,
    }, null)).resolves.toMatchObject({
      id: 'products',
      name: 'Catalog',
      slug: 'catalog',
      routeBase: '/catalog',
      fields: nextFields,
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
        expect(sql).toContain('data_row_versions.id = data_rows.active_version_id')
        expect(params).toEqual(['/posts', 'hello'])
        return {
          rows: [{
            id: 'version_1',
            row_id: 'row_1',
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

    await expect(getPublishedDataRowByRoute(db, '/posts', 'hello')).resolves.toMatchObject({
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
        expect(params).toEqual(['/posts', 'untitled'])
        return { rows: [], rowCount: 0 }
      },
    ])

    await expect(getPublishedDataRowByRoute(db, '/posts', 'untitled')).resolves.toBeNull()
  })

  it('resolves old published slugs as redirects to the active published slug', async () => {
    const db = makeDataFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select data_row_redirects.id')) return undefined
        expect(params).toEqual(['/posts', 'untitled'])
        return {
          rows: [{
            id: 'redirect_1',
            from_route_base: '/posts',
            from_slug: 'untitled',
            target_route_base: '/posts',
            target_slug: 'post',
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
  it('returns 404 when a postType row has no matching entry template', async () => {
    // The row route consults the version-keyed published-snapshot memo; reset
    // publish state so a snapshot cached by another test file can't leak in.
    resetForTests()
    // Defensive contract: `createDataTable` auto-seeds an entry template
    // for every postType table, and the boot backfill catches any older
    // table that's missing one. So `renderPublishedDataRowTemplate`
    // returning `null` here represents a corrupt install (template was
    // hard-deleted, no published site snapshot, etc.). The dispatcher
    // surfaces that as a 404 rather than inventing a half-styled
    // fallback document.
    const db = makeDataFakeDb([
      (sql) => {
        if (sql.startsWith('select id, name, version, enabled, lifecycle_status')) {
          return { rows: [], rowCount: 0 }
        }
        return undefined
      },
      (sql) => {
        // getPublishedPageBySlug / getLatestPublishedSiteSnapshot — no
        // published snapshot at all (both run the same site_snapshots join).
        if (sql.includes('site_snapshots.site_json')) {
          return { rows: [], rowCount: 0 }
        }
        return undefined
      },
      (sql) => {
        if (!sql.startsWith('select data_row_versions.id')) return undefined
        return {
          rows: [{
            id: 'version_1',
            row_id: 'row_1',
            table_id: 'products',
            table_slug: 'products',
            table_kind: 'postType',
            table_route_base: '/products',
            version_number: 1,
            cells_json: {
              title: 'Some product',
              slug: 'some-product',
              body: 'A product body.',
              featuredMedia: null,
              seoTitle: '',
              seoDescription: '',
            },
            slug: 'some-product',
            published_at: rowDate('2026-05-01T10:00:00Z'),
            created_at: rowDate('2026-05-01T10:00:00Z'),
          }],
          rowCount: 1,
        }
      },
      (sql) => {
        // No redirect for this slug either.
        if (sql.startsWith('select id, table_id, from_route_base')) {
          return { rows: [], rowCount: 0 }
        }
        return undefined
      },
      (sql) => {
        if (sql.startsWith('select count(*) as count from site')) {
          return { rows: [{ count: 1 }], rowCount: 1 }
        }
        if (sql.startsWith('select count(*) as count') && sql.includes('from users')) {
          return { rows: [{ count: 1 }], rowCount: 1 }
        }
        return undefined
      },
    ])

    const res = await handleServerRequest(new Request('http://localhost/products/some-product'), { db })

    expect(res.status).toBe(404)
  })
})
