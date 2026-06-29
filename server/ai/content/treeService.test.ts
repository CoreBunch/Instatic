import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { readPageTree, mutatePageTree } from './treeService'

const ENTRY_ID = 'page1'

const INITIAL_TREE = {
  rootNodeId: 'root',
  nodes: {
    root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, classIds: [], children: [] },
  },
}

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  // Seed a page row in the (already-seeded) `pages` system table with a
  // minimal valid pageTree in its `body` field.
  const cells = JSON.stringify({ title: 'Home', slug: 'home', body: INITIAL_TREE })
  await db`
    insert into data_rows (id, table_id, cells_json, slug, status)
    values (${ENTRY_ID}, 'pages', ${cells}, 'home', 'draft')
  `
  return db
}

let db: DbClient
beforeEach(async () => { db = await freshDb() })

describe('content tree service', () => {
  it('reads a page tree', async () => {
    const tree = await readPageTree(db, ENTRY_ID, 'body')
    expect(tree).toBeTruthy()
    expect((tree as { rootNodeId: string }).rootNodeId).toBe('root')
  })

  it('applies a node insert and persists', async () => {
    const result = await mutatePageTree(
      db,
      ENTRY_ID,
      'body',
      [
        {
          kind: 'insertNode',
          parentId: 'root',
          index: 0,
          node: { id: 'n_test', moduleId: 'base.text', props: {}, breakpointOverrides: {}, classIds: [], children: [] },
        },
      ],
      { kind: 'user', userId: 'u1' },
    )
    expect(result.affectedNodeIds).toContain('n_test')

    const after = await readPageTree(db, ENTRY_ID, 'body')
    expect(JSON.stringify(after)).toContain('n_test')
    expect((after as { nodes: Record<string, unknown> }).nodes.n_test).toBeTruthy()
  })

  it('runs the assertAccess hook before mutating and can deny', async () => {
    await expect(
      mutatePageTree(
        db,
        ENTRY_ID,
        'body',
        [{ kind: 'deleteNode', nodeId: 'root' }],
        { kind: 'user', userId: 'u1' },
        { assertAccess: () => { throw new Error('denied') } },
      ),
    ).rejects.toThrow('denied')
  })

  it('rejects a non-pageTree field', async () => {
    await expect(readPageTree(db, ENTRY_ID, 'title')).rejects.toThrow(/not a pageTree field/)
  })
})
