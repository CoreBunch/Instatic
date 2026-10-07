/**
 * Row-tool behaviour against a real migrated SQLite database.
 *
 * Row writes are the half of issue #463 that had no path at all over MCP, so
 * these assert the parts that make the path usable rather than merely present:
 * the batch is transactional, a slug conflict is named instead of surfacing as
 * a driver error, and the merge default lets an agent set one cell without
 * re-sending the row.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import type { CoreCapability } from '@core/capabilities'
import type { DbClient } from '../../../db/client'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import { listAuditEvents } from '../../../repositories/audit'
import { createDataRow, getDataRow, listDataRows } from '../../../repositories/data'
import { MAIN_SCOPE } from '../../../branches/scope'
import type { AiTool, ToolContext } from '../../runtime/types'
import { dataTools } from './index'

const FULL_CAPS: CoreCapability[] = [
  'ai.chat',
  'ai.tools.write',
  'content.create',
  'content.manage',
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
]

/** Can create a row but not edit one — the split `requireDataCreator` enforces. */
const CREATE_ONLY_CAPS: CoreCapability[] = ['content.create', 'data.custom.tables.read']

/** May edit any row, but only reads custom tables — system tables are off limits. */
const CUSTOM_ONLY_EDIT_CAPS: CoreCapability[] = ['content.edit.any', 'data.custom.tables.read']

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
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
  capabilities: CoreCapability[] = FULL_CAPS,
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

/** A table with a `slug` field, so slug derivation and its unique index apply. */
async function trainingsTable(db: DbClient): Promise<string> {
  const created = await run('data_create_table', {
    name: 'Trainings',
    fields: [
      { id: 'name', label: 'Name', type: 'text' },
      { id: 'slug', label: 'Slug', type: 'text' },
      { id: 'price', label: 'Price', type: 'number' },
    ],
    primaryFieldId: 'name',
  }, db) as { table: { id: string } }
  return created.table.id
}

describe('data_create_rows', () => {
  let db: DbClient
  let tableId: string

  beforeEach(async () => {
    db = await freshDb()
    tableId = await trainingsTable(db)
  })

  it('writes a whole batch and returns the rows as stored', async () => {
    const result = await run('data_create_rows', {
      tableId,
      rows: [
        { cells: { name: 'Basics', slug: 'basics', price: 100 } },
        { cells: { name: 'Advanced', slug: 'advanced', price: 200 } },
        { cells: { name: 'Expert', slug: 'expert', price: 300 } },
      ],
    }, db) as { rows: Array<{ id: string; slug: string; status: string; cells: Record<string, unknown> }> }

    expect(result.rows).toHaveLength(3)
    expect(result.rows.map((row) => row.slug)).toEqual(['basics', 'advanced', 'expert'])
    // Rows land as drafts; publishing is an explicit second call.
    expect(result.rows.every((row) => row.status === 'draft')).toBe(true)
    expect(result.rows[0].cells.price).toBe(100)

    const stored = await listDataRows(db, MAIN_SCOPE, tableId)
    expect(stored).toHaveLength(3)
  })

  it('aborts the entire batch when two rows in it share a slug', async () => {
    const result = await run('data_create_rows', {
      tableId,
      rows: [
        { cells: { name: 'Basics', slug: 'basics' } },
        { cells: { name: 'Basics again', slug: 'basics' } },
        { cells: { name: 'Advanced', slug: 'advanced' } },
      ],
    }, db) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/used twice in this batch/)
    // Not even the first, valid row was written.
    expect(await listDataRows(db, MAIN_SCOPE, tableId)).toHaveLength(0)
  })

  it('names a collision with a row already in the table', async () => {
    await run('data_create_rows', {
      tableId,
      rows: [{ cells: { name: 'Basics', slug: 'basics' } }],
    }, db)

    const result = await run('data_create_rows', {
      tableId,
      rows: [{ cells: { name: 'Basics reloaded', slug: 'basics' } }],
    }, db) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already exists in this table/)
    expect(await listDataRows(db, MAIN_SCOPE, tableId)).toHaveLength(1)
  })

  it('refuses a cell that targets an editor-managed built-in field', async () => {
    // `pages` stores its tree in a built-in the visual editor owns; a row
    // created through the generic path must not be able to seed it.
    const result = await run('data_create_rows', {
      tableId: 'pages',
      rows: [{ cells: { title: 'Home', tree: {} } }],
    }, db) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/managed by the editor/)
  })

  it('reports an unknown table as not found', async () => {
    const result = await run('data_create_rows', {
      tableId: 'nope',
      rows: [{ cells: { name: 'X' } }],
    }, db) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it('records one audit event per created row, carrying the connector id', async () => {
    await run('data_create_rows', {
      tableId,
      rows: [
        { cells: { name: 'Basics', slug: 'basics' } },
        { cells: { name: 'Advanced', slug: 'advanced' } },
      ],
    }, db)

    const created = (await listAuditEvents(db)).filter((e) => e.action === 'data.row.create')
    expect(created).toHaveLength(2)
    expect(created[0].metadata).toMatchObject({ tableId, source: 'mcp', connectorId: 'connector-1' })
  })
})

describe('data_update_row', () => {
  let db: DbClient
  let tableId: string
  let rowId: string

  beforeEach(async () => {
    db = await freshDb()
    tableId = await trainingsTable(db)
    const created = await run('data_create_rows', {
      tableId,
      rows: [{ cells: { name: 'Basics', slug: 'basics', price: 100 } }],
    }, db) as { rows: Array<{ id: string }> }
    rowId = created.rows[0].id
  })

  it('merges by default, leaving untouched cells alone', async () => {
    const result = await run('data_update_row', {
      rowId,
      cells: { price: 150 },
    }, db) as { row: { cells: Record<string, unknown>; slug: string } }

    expect(result.row.cells.price).toBe(150)
    expect(result.row.cells.name).toBe('Basics')
    expect(result.row.slug).toBe('basics')
  })

  it('replaces the whole cell set when merge is false', async () => {
    const result = await run('data_update_row', {
      rowId,
      cells: { name: 'Basics', slug: 'basics' },
      merge: false,
    }, db) as { row: { cells: Record<string, unknown> } }

    expect(result.row.cells.price).toBeUndefined()
  })

  it('re-derives the slug when the slug cell changes', async () => {
    const result = await run('data_update_row', {
      rowId,
      cells: { slug: 'Basics Reloaded' },
    }, db) as { row: { slug: string } }

    expect(result.row.slug).toBe('basics-reloaded')
    const stored = await getDataRow(db, MAIN_SCOPE, rowId)
    expect(stored!.slug).toBe('basics-reloaded')
  })

  it('names a slug collision with a sibling row', async () => {
    await run('data_create_rows', {
      tableId,
      rows: [{ cells: { name: 'Advanced', slug: 'advanced' } }],
    }, db)

    const result = await run('data_update_row', {
      rowId,
      cells: { slug: 'advanced' },
    }, db) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already exists in this table/)
    const stored = await getDataRow(db, MAIN_SCOPE, rowId)
    expect(stored!.slug).toBe('basics')
  })

  it("reports a row the caller may not edit as not found", async () => {
    const result = await run('data_update_row', {
      rowId,
      cells: { price: 999 },
    }, db, CREATE_ONLY_CAPS) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/)
    const stored = await getDataRow(db, MAIN_SCOPE, rowId)
    expect(stored!.cells.price).toBe(100)
  })

  it('refuses a system-table row to a caller who cannot read system tables', async () => {
    // content.edit.any passes the row check on every row, so the table-family
    // boundary is the only thing keeping this caller out of `posts` — the
    // same order the HTTP row routes enforce (GHSA-x69h).
    const post = await createDataRow(db, MAIN_SCOPE, {
      tableId: 'posts',
      cells: { title: 'Hello', slug: 'hello' },
      slug: 'hello',
    }, 'user-1')

    const result = await run('data_update_row', {
      rowId: post.id,
      cells: { title: 'Hijacked' },
    }, db, CUSTOM_ONLY_EDIT_CAPS) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/)
    const stored = await getDataRow(db, MAIN_SCOPE, post.id)
    expect(stored!.cells.title).toBe('Hello')
  })

  it('describes cells by field id and points at the schema and row reads', () => {
    // The description used to send the agent to data_list_tables for field
    // ids, which does not return them — every first call guessed wrong.
    const description = toolByName('data_create_rows').description
    expect(description).toContain('content_get_collection_schema')
    expect(description).toContain('content_list_documents')
    expect(description).not.toContain('data_list_tables for')
  })

  it('returns payloads matching the advertised outputSchemas', async () => {
    const created = await run('data_create_rows', {
      tableId,
      rows: [{ cells: { name: 'Intro', slug: 'intro', price: 100 } }],
    }, db)
    expect(Value.Check(toolByName('data_create_rows').outputSchema!, created)).toBe(true)

    const updated = await run('data_update_row', { rowId, cells: { price: 120 } }, db)
    expect(Value.Check(toolByName('data_update_row').outputSchema!, updated)).toBe(true)
  })
})
