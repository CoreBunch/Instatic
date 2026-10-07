/**
 * Publish / retract / delete behaviour against a real migrated SQLite database.
 *
 * The case worth pinning is publishing a row in a table with no route base:
 * that is the default shape of a reusable data table, and if the publisher
 * refused it the whole point of issue #463 — feed a loop from an agent-written
 * table — would not work. The rest guards the partial-failure contract, which
 * differs from the all-or-nothing contract of `data_create_rows`.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { CoreCapability } from '@core/capabilities'
import { physicalId } from '@core/branches'
import type { DbClient } from '../../../db/client'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import { listAuditEvents } from '../../../repositories/audit'
import { createDataRow, getDataRow, listDataRows } from '../../../repositories/data'
import { MAIN_SCOPE, type BranchScope } from '../../../branches/scope'
import { forkBranch } from '../../../branches/fork'
import { getPublishVersion } from '../../../publish/publishState'
import type { AiTool, ToolContext } from '../../runtime/types'
import { selectToolsForScope } from '../index'
import { dataTools } from './index'

const FULL_CAPS: CoreCapability[] = [
  'content.create',
  'content.manage',
  'content.publish.any',
  'data.custom.tables.read',
  'data.custom.tables.manage',
]

/** What the in-app chat handler holds when it builds the data toolset. */
const CHAT_CAPS: CoreCapability[] = ['ai.chat', 'ai.tools.write', ...FULL_CAPS]

const BRANCH_SCOPE: BranchScope = { branchId: 'feature-1' }

/** May write and retract rows, but never publish one. */
const NO_PUBLISH_CAPS: CoreCapability[] = [
  'content.create',
  'content.edit.any',
  'data.custom.tables.read',
]

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
  // No `uploadsDir`, so nothing tries to touch the disk: these assert database
  // state, and the artefact writer is exercised by the publisher's own tests.
  const tool = dataTools().find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`tool ${name} is not registered`)
  return tool
}

function run(
  name: string,
  input: Record<string, unknown>,
  db: DbClient,
  capabilities: CoreCapability[] = FULL_CAPS,
  branch: BranchScope = MAIN_SCOPE,
  tool: AiTool = toolByName(name),
): Promise<unknown> {
  const ctx: ToolContext = {
    db,
    branch,
    userId: 'user-1',
    capabilities,
    scope: 'data',
    conversationId: 'conversation-1',
    snapshot: null,
    signal: new AbortController().signal,
  }
  return tool.handler!(input, ctx)
}

/**
 * The toolset the in-app Data chat gets — built the way the chat handler
 * builds it, so these cases fail if the uploads dir stops being threaded
 * through and the artefact writes go silently dead again.
 */
function chatTool(name: string, uploadsDir: string): AiTool {
  const tool = selectToolsForScope('data', CHAT_CAPS, { uploadsDir })
    .find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`tool ${name} is not offered to the in-app data chat`)
  return tool
}

interface Seeded {
  tableId: string
  rowIds: string[]
}

/** A `kind: 'data'` table — no route base, which is the case under test. */
async function seedTrainings(
  db: DbClient,
  count = 2,
  branch: BranchScope = MAIN_SCOPE,
): Promise<Seeded> {
  const created = await run('data_create_table', {
    name: 'Trainings',
    fields: [
      { id: 'name', label: 'Name', type: 'text' },
      { id: 'slug', label: 'Slug', type: 'text' },
    ],
    primaryFieldId: 'name',
  }, db, FULL_CAPS, branch) as { table: { id: string; routeBase: string } }
  expect(created.table.routeBase).toBe('')

  const rows = await run('data_create_rows', {
    tableId: created.table.id,
    rows: Array.from({ length: count }, (_, i) => ({
      cells: { name: `Training ${i}`, slug: `training-${i}` },
    })),
  }, db, FULL_CAPS, branch) as { rows: Array<{ id: string }> }

  return { tableId: created.table.id, rowIds: rows.rows.map((row) => row.id) }
}

describe('data_set_rows_status', () => {
  let db: DbClient
  let seeded: Seeded

  beforeEach(async () => {
    db = await freshDb()
    seeded = await seedTrainings(db)
  })

  it('publishes rows in a table that has no public route base', async () => {
    const result = await run('data_set_rows_status', {
      rowIds: seeded.rowIds,
      status: 'published',
    }, db) as { updated: Array<{ id: string; status: string }>; failed: unknown[] }

    expect(result.failed).toHaveLength(0)
    expect(result.updated.map((row) => row.status)).toEqual(['published', 'published'])
    // What makes a loop on another page pick the row up.
    const stored = await getDataRow(db, MAIN_SCOPE, seeded.rowIds[0])
    expect(stored!.status).toBe('published')
  })

  it('retracts a published row back to draft', async () => {
    await run('data_set_rows_status', { rowIds: seeded.rowIds, status: 'published' }, db)

    const result = await run('data_set_rows_status', {
      rowIds: [seeded.rowIds[0]],
      status: 'draft',
    }, db) as { updated: Array<{ status: string }> }

    expect(result.updated[0].status).toBe('draft')
    expect((await getDataRow(db, MAIN_SCOPE, seeded.rowIds[1]))!.status).toBe('published')
  })

  it('reports the rows it could not touch and still applies the rest', async () => {
    const result = await run('data_set_rows_status', {
      rowIds: [seeded.rowIds[0], 'missing-row'],
      status: 'published',
    }, db) as {
      updated: Array<{ id: string }>
      failed: Array<{ rowId: string; error: string }>
    }

    expect(result.updated.map((row) => row.id)).toEqual([seeded.rowIds[0]])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].rowId).toBe('missing-row')
    expect(result.failed[0].error).toMatch(/not found/)
  })

  it('refuses to publish for a caller with edit but no publish capability', async () => {
    const result = await run('data_set_rows_status', {
      rowIds: seeded.rowIds,
      status: 'published',
    }, db, NO_PUBLISH_CAPS) as { updated: unknown[]; failed: unknown[] }

    expect(result.updated).toHaveLength(0)
    expect(result.failed).toHaveLength(2)
    expect((await getDataRow(db, MAIN_SCOPE, seeded.rowIds[0]))!.status).toBe('draft')
  })

  it('audits a publish distinctly from a retraction', async () => {
    await run('data_set_rows_status', { rowIds: [seeded.rowIds[0]], status: 'published' }, db)
    await run('data_set_rows_status', { rowIds: [seeded.rowIds[0]], status: 'unpublished' }, db)

    const actions = (await listAuditEvents(db)).map((event) => event.action)
    expect(actions).toContain('data.row.publish')
    expect(actions).toContain('data.row.status')
  })
})

describe('data_delete_rows', () => {
  let db: DbClient
  let seeded: Seeded

  beforeEach(async () => {
    db = await freshDb()
    seeded = await seedTrainings(db, 3)
  })

  it('soft-deletes the rows it was given and leaves the others', async () => {
    const result = await run('data_delete_rows', {
      rowIds: seeded.rowIds.slice(0, 2),
    }, db) as { deleted: Array<{ id: string }>; failed: unknown[] }

    expect(result.deleted).toHaveLength(2)
    expect(result.failed).toHaveLength(0)
    const remaining = await listDataRows(db, MAIN_SCOPE, seeded.tableId)
    expect(remaining.map((row) => row.id)).toEqual([seeded.rowIds[2]])
    // Soft, not hard — the row is gone from every listing but still stored.
    expect(await getDataRow(db, MAIN_SCOPE, seeded.rowIds[0])).toBeNull()
  })

  it('deletes a published row, which retracts its public route', async () => {
    await run('data_set_rows_status', { rowIds: [seeded.rowIds[0]], status: 'published' }, db)

    const result = await run('data_delete_rows', { rowIds: [seeded.rowIds[0]] }, db) as {
      deleted: unknown[]
    }
    expect(result.deleted).toHaveLength(1)
    expect(await listDataRows(db, MAIN_SCOPE, seeded.tableId)).toHaveLength(2)
  })

  it('reports unknown ids without blocking the deletable ones', async () => {
    const result = await run('data_delete_rows', {
      rowIds: [seeded.rowIds[0], 'missing-row'],
    }, db) as { deleted: Array<{ id: string }>; failed: Array<{ rowId: string }> }

    expect(result.deleted.map((row) => row.id)).toEqual([seeded.rowIds[0]])
    expect(result.failed.map((row) => row.rowId)).toEqual(['missing-row'])
  })

  it('writes nothing when no row is deletable', async () => {
    const result = await run('data_delete_rows', { rowIds: ['a', 'b'] }, db) as {
      deleted: unknown[]
      failed: unknown[]
    }
    expect(result.deleted).toHaveLength(0)
    expect(result.failed).toHaveLength(2)
    expect(await listDataRows(db, MAIN_SCOPE, seeded.tableId)).toHaveLength(3)
  })
})

/**
 * A broad `content.*` capability passes the per-row check on any row, so the
 * table-family boundary is what keeps a custom-tables-only caller out of the
 * seeded system tables — the order the HTTP row routes enforce (GHSA-x69h).
 */
describe('system-table rows', () => {
  /** Publishes, retracts and deletes any row, but reads only custom tables. */
  const CUSTOM_ONLY_CAPS: CoreCapability[] = [
    'content.edit.any',
    'content.publish.any',
    'data.custom.tables.read',
  ]

  let db: DbClient
  let postId: string

  beforeEach(async () => {
    db = await freshDb()
    const post = await createDataRow(db, MAIN_SCOPE, {
      tableId: 'posts',
      cells: { title: 'Hello', slug: 'hello' },
      slug: 'hello',
    }, 'user-1')
    postId = post.id
  })

  it('refuses to publish or retract a post for a caller who cannot read system tables', async () => {
    for (const status of ['published', 'unpublished'] as const) {
      const result = await run('data_set_rows_status', {
        rowIds: [postId],
        status,
      }, db, CUSTOM_ONLY_CAPS) as { updated: unknown[]; failed: Array<{ error: string }> }

      expect(result.updated).toHaveLength(0)
      expect(result.failed[0].error).toMatch(/not found/)
    }
    expect((await getDataRow(db, MAIN_SCOPE, postId))!.status).toBe('draft')
  })

  it('refuses to delete a post for a caller who cannot read system tables', async () => {
    const result = await run('data_delete_rows', {
      rowIds: [postId],
    }, db, CUSTOM_ONLY_CAPS) as { deleted: unknown[]; failed: unknown[] }

    expect(result.deleted).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
    expect(await getDataRow(db, MAIN_SCOPE, postId)).not.toBeNull()
  })
})

/**
 * Publishing exists on main only: the tool reads and authorizes the row at
 * `ctx.branch`, but `persistDataRowPublish` reads and writes `MAIN_SCOPE`, so
 * an off-main publish would check one row and ship another.
 *
 * Retraction and deletion stay available on a branch — they write through
 * `ctx.branch` — but must not touch main's baked artefact or its render
 * cache. The branch here is a real fork, which is what makes that dangerous:
 * every row keeps main's logical id and slug, and `removeDataRowArtefact`
 * resolves the route by row id with NO branch filter, so an unguarded branch
 * retraction unlinks main's live page.
 */
describe('branch scope', () => {
  let db: DbClient
  let seeded: Seeded
  let uploadsDir: string

  /** Where a row in a table with no route base bakes: `/<slug>` -> `<slug>.html`. */
  function artefactPath(slug: string): string {
    return join(uploadsDir, 'published', 'a', `${slug}.html`)
  }

  async function seedArtefact(slug: string): Promise<string> {
    const path = artefactPath(slug)
    await mkdir(join(uploadsDir, 'published', 'a'), { recursive: true })
    await writeFile(path, '<html>live</html>', 'utf-8')
    return path
  }

  /** `updateDataRowStatus` only moves a row down, and a branch publish is refused. */
  async function forcePublished(rowId: string, branch: BranchScope): Promise<void> {
    await db`
      update data_rows set status = 'published'
      where id = ${physicalId(branch.branchId, rowId)}
    `
  }

  beforeEach(async () => {
    db = await freshDb()
    seeded = await seedTrainings(db)
    uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-lifecycle-'))
    await run('data_set_rows_status', { rowIds: [seeded.rowIds[0]], status: 'published' }, db)
    await forkBranch(db, {
      id: BRANCH_SCOPE.branchId,
      name: 'Feature',
      fromBranchId: MAIN_SCOPE.branchId,
      createdByUserId: 'user-1',
    })
  })

  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('refuses a publish from a branch instead of publishing the row on main', async () => {
    const result = await run('data_set_rows_status', {
      rowIds: [seeded.rowIds[1]],
      status: 'published',
    }, db, FULL_CAPS, BRANCH_SCOPE) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/only available on main/)
    expect((await getDataRow(db, BRANCH_SCOPE, seeded.rowIds[1]))!.status).toBe('draft')
    // The row the write would have landed on.
    expect((await getDataRow(db, MAIN_SCOPE, seeded.rowIds[1]))!.status).toBe('draft')
  })

  it('still retracts on a branch, and only on the branch', async () => {
    const result = await run('data_set_rows_status', {
      rowIds: [seeded.rowIds[0]],
      status: 'unpublished',
    }, db, FULL_CAPS, BRANCH_SCOPE) as { updated: Array<{ status: string }>; failed: unknown[] }

    expect(result.failed).toHaveLength(0)
    expect(result.updated[0].status).toBe('unpublished')
    expect((await getDataRow(db, MAIN_SCOPE, seeded.rowIds[0]))!.status).toBe('published')
  })

  it('leaves the live artefact in place when the branch copy is retracted', async () => {
    const path = await seedArtefact('training-0')

    await run('data_set_rows_status', {
      rowIds: [seeded.rowIds[0]],
      status: 'unpublished',
    }, db, CHAT_CAPS, BRANCH_SCOPE, chatTool('data_set_rows_status', uploadsDir))

    expect(existsSync(path)).toBe(true)
  })

  it('removes the artefact when the same retraction runs on main', async () => {
    const path = await seedArtefact('training-0')

    await run('data_set_rows_status', {
      rowIds: [seeded.rowIds[0]],
      status: 'unpublished',
    }, db, CHAT_CAPS, MAIN_SCOPE, chatTool('data_set_rows_status', uploadsDir))

    expect(existsSync(path)).toBe(false)
  })

  it('deleting the branch copy touches neither the artefact nor the publish version', async () => {
    const path = await seedArtefact('training-0')
    await forcePublished(seeded.rowIds[0], BRANCH_SCOPE)
    const versionBefore = getPublishVersion()

    const result = await run('data_delete_rows', {
      rowIds: [seeded.rowIds[0]],
    }, db, CHAT_CAPS, BRANCH_SCOPE, chatTool('data_delete_rows', uploadsDir)) as {
      deleted: unknown[]
    }

    expect(result.deleted).toHaveLength(1)
    expect(existsSync(path)).toBe(true)
    expect(getPublishVersion()).toBe(versionBefore)
    // Main's row is untouched by the branch delete.
    expect((await getDataRow(db, MAIN_SCOPE, seeded.rowIds[0]))!.status).toBe('published')
  })

  it('deleting the published row on main removes the artefact and bumps the version', async () => {
    const path = await seedArtefact('training-0')
    const versionBefore = getPublishVersion()

    await run('data_delete_rows', {
      rowIds: [seeded.rowIds[0]],
    }, db, CHAT_CAPS, MAIN_SCOPE, chatTool('data_delete_rows', uploadsDir))

    expect(existsSync(path)).toBe(false)
    expect(getPublishVersion()).toBeGreaterThan(versionBefore)
  })
})
