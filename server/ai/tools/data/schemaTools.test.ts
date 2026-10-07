/**
 * Schema-tool behaviour against a real migrated SQLite database.
 *
 * These run the handlers, not a mock of them: the point of the toolset is that
 * it reuses the repository and the HTTP route's access predicates, and only a
 * real schema proves the reuse holds (seeded system tables, the active-slug
 * unique index, the field normalizer).
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import type { CoreCapability } from '@core/capabilities'
import type { DataTable } from '@core/data/schemas'
import type { DbClient } from '../../../db/client'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import { listAuditEvents } from '../../../repositories/audit'
import { getDataTable, getDataTableBySlug } from '../../../repositories/data'
import { MAIN_SCOPE } from '../../../branches/scope'
import type { AiTool, ToolContext } from '../../runtime/types'
import { dataTools } from './index'

const MANAGE_CAPS: CoreCapability[] = [
  'ai.chat',
  'ai.tools.write',
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
]

/** A connector granted only the custom-table read cap — no system, no content. */
const CUSTOM_ONLY_CAPS: CoreCapability[] = ['data.custom.tables.read']

/** Adds the system-table manage grant, which `canManageTable` requires for `posts`. */
const SYSTEM_MANAGE_CAPS: CoreCapability[] = [...MANAGE_CAPS, 'data.system.tables.manage']

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  // `created_by_user_id` carries a foreign key, so the actor has to exist.
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('user-1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  return db
}

function toolByName(name: string): AiTool {
  const tool = dataTools({ connectorId: 'connector-1', uploadsDir: '/tmp/uploads' })
    .find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`tool ${name} is not registered`)
  return tool
}

function run(
  name: string,
  input: Record<string, unknown>,
  db: DbClient,
  capabilities: CoreCapability[] = MANAGE_CAPS,
): Promise<unknown> {
  const ctx: ToolContext = {
    db,
    branch: MAIN_SCOPE,
    userId: 'user-1',
    capabilities,
    scope: 'data',
    conversationId: 'conversation-1',
    snapshot: null,
    signal: new AbortController().signal,
  }
  return toolByName(name).handler!(input, ctx)
}

/** The seeded `posts` system table, used for the frozen-surface assertions. */
async function postsTable(db: DbClient): Promise<DataTable> {
  const table = await getDataTableBySlug(db, MAIN_SCOPE, 'posts')
  if (!table) throw new Error('the posts system table was not seeded')
  return table
}

describe('data_list_tables', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('lists reusable data tables, which content_list_collections excludes', async () => {
    await run('data_create_table', {
      name: 'Trainings',
      kind: 'data',
      fields: [{ id: 'name', label: 'Name', type: 'text' }],
    }, db)

    const result = await run('data_list_tables', {}, db) as {
      tables: Array<{ slug: string; kind: string; routable: boolean; rowCount: number }>
    }

    const trainings = result.tables.find((t) => t.slug === 'trainings')
    expect(trainings).toBeDefined()
    expect(trainings!.kind).toBe('data')
    expect(trainings!.rowCount).toBe(0)
    // kind 'data' gets no route base, so no per-row public URLs.
    expect(trainings!.routable).toBe(false)
  })

  it('points at the content reads for table fields and rows', () => {
    // The only way to read a data table's rows and field ids; if the pointer
    // goes stale an agent has no path from a table id to its contents.
    const description = toolByName('data_list_tables').description
    expect(description).toContain('content_get_collection_schema')
    expect(description).toContain('content_list_documents')
  })

  it('returns a payload matching its advertised outputSchema', async () => {
    await run('data_create_table', {
      name: 'Trainings',
      kind: 'data',
      fields: [{ id: 'name', label: 'Name', type: 'text' }],
    }, db)
    const result = await run('data_list_tables', {}, db)
    expect(Value.Check(toolByName('data_list_tables').outputSchema!, result)).toBe(true)
  })

  it('never lists page, component, or layout tables', async () => {
    const result = await run('data_list_tables', {}, db) as { tables: Array<{ slug: string }> }
    const slugs = result.tables.map((t) => t.slug)
    expect(slugs).not.toContain('pages')
    expect(slugs).not.toContain('components')
    expect(slugs).not.toContain('layouts')
    // The seeded `posts` post type is authorable, so it stays.
    expect(slugs).toContain('posts')
  })

  it('narrows to one kind when asked', async () => {
    await run('data_create_table', { name: 'Trainings', kind: 'data' }, db)

    const dataOnly = await run('data_list_tables', { kind: 'data' }, db) as {
      tables: Array<{ slug: string }>
    }
    expect(dataOnly.tables.map((t) => t.slug)).toEqual(['trainings'])

    const postTypesOnly = await run('data_list_tables', { kind: 'postType' }, db) as {
      tables: Array<{ slug: string }>
    }
    expect(postTypesOnly.tables.map((t) => t.slug)).toEqual(['posts'])
  })

  it('hides system tables from a custom-only caller, as the HTTP list route does', async () => {
    await run('data_create_table', { name: 'Trainings', kind: 'data' }, db)

    const result = await run('data_list_tables', {}, db, CUSTOM_ONLY_CAPS) as {
      tables: Array<{ slug: string }>
    }
    // `posts` is seeded with system=true, so a custom-only grant cannot see it.
    expect(result.tables.map((t) => t.slug)).toEqual(['trainings'])
  })
})

describe('data_create_table', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('stores the fields it was given and returns them as stored', async () => {
    const result = await run('data_create_table', {
      name: 'Trainings',
      fields: [
        { id: 'name', label: 'Name', type: 'text' },
        { id: 'price', label: 'Price', type: 'number' },
        { id: 'bookingurl', label: 'Booking URL', type: 'url' },
      ],
      primaryFieldId: 'name',
    }, db) as { table: { id: string; fields: Array<{ id: string; type: string }> } }

    expect(result.table.fields.map((f) => f.id)).toEqual(['name', 'price', 'bookingurl'])

    // The agent wires loops against what was persisted, not what it sent.
    const stored = await getDataTable(db, MAIN_SCOPE, result.table.id)
    expect(stored!.fields.map((f) => f.type)).toEqual(['text', 'number', 'url'])
    expect(stored!.primaryFieldId).toBe('name')
  })

  it('defaults kind to data, derives slug and labels from the name', async () => {
    const result = await run('data_create_table', { name: 'Team Members' }, db) as {
      table: { slug: string; kind: string; singularLabel: string; pluralLabel: string; routeBase: string }
    }
    expect(result.table.kind).toBe('data')
    expect(result.table.slug).toBe('team-members')
    expect(result.table.pluralLabel).toBe('Team Members')
    expect(result.table.singularLabel).toBe('Team Member')
  })

  it('gives a post type a route base so its rows get public URLs', async () => {
    const result = await run('data_create_table', { name: 'Guides', kind: 'postType' }, db) as {
      table: { kind: string; routeBase: string }
    }
    expect(result.table.kind).toBe('postType')
    expect(result.table.routeBase).toBe('/guides')
  })

  it('names a slug collision instead of letting the unique index throw', async () => {
    await run('data_create_table', { name: 'Trainings' }, db)
    const second = await run('data_create_table', { name: 'Trainings' }, db) as {
      ok: boolean
      error: string
    }
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/already exists/)
    expect(second.error).toMatch(/trainings/)
  })

  it('refuses field types reserved for the built-in page and component tables', async () => {
    const result = await run('data_create_table', {
      name: 'Trainings',
      fields: [{ id: 'body', label: 'Body', type: 'pageTree' }],
    }, db) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/reserved/)
    // Nothing was written.
    const listed = await run('data_list_tables', { kind: 'data' }, db) as { tables: unknown[] }
    expect(listed.tables).toHaveLength(0)
  })

  it('honours an explicit route base on a data table', async () => {
    const result = await run('data_create_table', {
      name: 'Guides',
      kind: 'data',
      routeBase: '/guides',
    }, db) as { table: { routeBase: string } }
    expect(result.table.routeBase).toBe('/guides')
  })

  it('records an audit event carrying the connector id', async () => {
    await run('data_create_table', { name: 'Trainings' }, db)

    const events = await listAuditEvents(db)
    const created = events.find((event) => event.action === 'data.table.create')
    expect(created).toBeDefined()
    expect(created!.actorUserId).toBe('user-1')
    expect(created!.metadata).toMatchObject({
      slug: 'trainings',
      source: 'mcp',
      connectorId: 'connector-1',
    })
  })
})


describe('data_update_table', () => {
  let db: DbClient
  let tableId: string

  beforeEach(async () => {
    db = await freshDb()
    const created = await run('data_create_table', {
      name: 'Trainings',
      fields: [
        { id: 'name', label: 'Name', type: 'text' },
        { id: 'price', label: 'Price', type: 'number' },
      ],
    }, db) as { table: { id: string } }
    tableId = created.table.id
  })

  it('replaces the whole field array, dropping what was omitted', async () => {
    const result = await run('data_update_table', {
      tableId,
      fields: [{ id: 'name', label: 'Name', type: 'text' }],
    }, db) as { table: { fields: Array<{ id: string }> } }

    expect(result.table.fields.map((f) => f.id)).toEqual(['name'])
    const stored = await getDataTable(db, MAIN_SCOPE, tableId)
    expect(stored!.fields.map((f) => f.id)).toEqual(['name'])
  })

  it('renames the table and re-derives the slug from what it was given', async () => {
    const result = await run('data_update_table', {
      tableId,
      name: 'Course Catalogue',
      slug: 'Course Catalogue',
    }, db) as { table: { name: string; slug: string } }

    expect(result.table.name).toBe('Course Catalogue')
    expect(result.table.slug).toBe('course-catalogue')
  })

  it('refuses a call that asks for no change', async () => {
    const result = await run('data_update_table', { tableId }, db) as {
      ok: boolean
      error: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/at least one property/)
  })

  it('names a slug collision instead of letting the unique index throw', async () => {
    await run('data_create_table', { name: 'Guides' }, db)

    const result = await run('data_update_table', { tableId, slug: 'guides' }, db) as {
      ok: boolean
      error: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already exists/)
    // The rename was rejected before it was written.
    const stored = await getDataTable(db, MAIN_SCOPE, tableId)
    expect(stored!.slug).toBe('trainings')
  })

  it('reports an unmanageable table as not found rather than forbidden', async () => {
    const result = await run('data_update_table', {
      tableId,
      name: 'Renamed',
    }, db, CUSTOM_ONLY_CAPS) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it("refuses to rename a system table even with the system manage grant", async () => {
    const posts = await postsTable(db)

    const result = await run('data_update_table', {
      tableId: posts.id,
      name: 'Articles',
    }, db, SYSTEM_MANAGE_CAPS) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/System tables can't change their name/)
    const stored = await getDataTable(db, MAIN_SCOPE, posts.id)
    expect(stored!.name).toBe(posts.name)
  })

  it('refuses to drop a built-in field off a system table', async () => {
    const posts = await postsTable(db)

    const result = await run('data_update_table', {
      tableId: posts.id,
      fields: [{ id: 'summary', label: 'Summary', type: 'text' }],
    }, db, SYSTEM_MANAGE_CAPS) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/built-in field/)
  })
})

describe('data_add_fields', () => {
  let db: DbClient
  let tableId: string

  beforeEach(async () => {
    db = await freshDb()
    const created = await run('data_create_table', {
      name: 'Trainings',
      fields: [{ id: 'name', label: 'Name', type: 'text' }],
    }, db) as { table: { id: string } }
    tableId = created.table.id
  })

  it('appends without disturbing the fields already there', async () => {
    const result = await run('data_add_fields', {
      tableId,
      fields: [
        { id: 'price', label: 'Price', type: 'number' },
        { id: 'bookingurl', label: 'Booking URL', type: 'url' },
      ],
    }, db) as { table: { fields: Array<{ id: string }> } }

    expect(result.table.fields.map((f) => f.id)).toEqual(['name', 'price', 'bookingurl'])
  })

  it('refuses a field id the table already has instead of overwriting it', async () => {
    const result = await run('data_add_fields', {
      tableId,
      fields: [{ id: 'name', label: 'Full name', type: 'text' }],
    }, db) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already has a field with id "name"/)
    // The original label survived.
    const stored = await getDataTable(db, MAIN_SCOPE, tableId)
    expect(stored!.fields.find((f) => f.id === 'name')!.label).toBe('Name')
  })

  it('adds a custom field to a system table, which data_update_table cannot rename', async () => {
    const posts = await postsTable(db)

    const result = await run('data_add_fields', {
      tableId: posts.id,
      fields: [{ id: 'readingtime', label: 'Reading time', type: 'number' }],
    }, db, SYSTEM_MANAGE_CAPS) as { table: { fields: Array<{ id: string }> } }

    const ids = result.table.fields.map((f) => f.id)
    expect(ids).toContain('readingtime')
    // Every built-in that was there before is still there.
    for (const field of posts.fields) expect(ids).toContain(field.id)
  })

  it('records an audit event so an MCP schema change is traceable', async () => {
    await run('data_add_fields', {
      tableId,
      fields: [{ id: 'price', label: 'Price', type: 'number' }],
    }, db)

    const events = await listAuditEvents(db)
    const updated = events.find((event) => event.action === 'data.table.update')
    expect(updated).toBeDefined()
    expect(updated!.metadata).toMatchObject({ slug: 'trainings', connectorId: 'connector-1' })
  })
})
