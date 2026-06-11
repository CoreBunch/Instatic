import { describe, expect, it } from 'bun:test'
import { createSqliteClient } from '../sqlite'

/**
 * The adapter executes through `db.query()`, bun:sqlite's cached-statement
 * variant of `prepare()` — statements are reused per exact SQL string. These
 * tests pin the behavioral edges of that reuse: parameters must be rebound on
 * every call (never replayed), and cached statements must survive schema
 * changes made after they were first compiled.
 */
describe('sqlite adapter statement caching', () => {
  it('rebinds params on each call of an identical SQL string (template path)', async () => {
    const db = createSqliteClient(':memory:')
    await db.unsafe('create table t (id text primary key, n integer)')

    // Identical SQL string per iteration → same cached statement, fresh binds.
    for (let i = 0; i < 3; i++) {
      await db`insert into t (id, n) values (${`row-${i}`}, ${i})`
    }

    const r0 = await db<{ n: number }>`select n from t where id = ${'row-0'}`
    const r2 = await db<{ n: number }>`select n from t where id = ${'row-2'}`
    expect(r0.rows[0]?.n).toBe(0)
    expect(r2.rows[0]?.n).toBe(2)
  })

  it('rebinds params on each call of an identical SQL string (unsafe path)', async () => {
    const db = createSqliteClient(':memory:')
    await db.unsafe('create table u (id text primary key, n integer)')
    await db.unsafe('insert into u (id, n) values (?, ?)', ['a', 1])
    await db.unsafe('insert into u (id, n) values (?, ?)', ['b', 2])

    const a = await db.unsafe<{ n: number }>('select n from u where id = ?', ['a'])
    const b = await db.unsafe<{ n: number }>('select n from u where id = ?', ['b'])
    expect(a.rows[0]?.n).toBe(1)
    expect(b.rows[0]?.n).toBe(2)
  })

  it('cached statements survive a later schema change; multi-statement exec path still works', async () => {
    const db = createSqliteClient(':memory:')
    // Multi-statement block must go through db.exec, not a prepared statement.
    await db.unsafe("create table m (id text primary key); insert into m (id) values ('a');")

    const before = await db<{ id: string }>`select id from m`
    expect(before.rowCount).toBe(1)

    // ALTER invalidates compiled statements; SQLite re-prepares transparently
    // when the cached statement for the identical SQL string runs again.
    await db.unsafe('alter table m add column extra text')
    const after = await db<{ id: string }>`select id from m`
    expect(after.rows[0]?.id).toBe('a')
  })

  it('still auto-parses *_json columns and reports rowCount for writes', async () => {
    const db = createSqliteClient(':memory:')
    await db.unsafe('create table j (id text primary key, payload_json text)')

    const write = await db`insert into j (id, payload_json) values (${'x'}, ${{ k: 1 }})`
    expect(write.rowCount).toBe(1)

    const read = await db<{ payload_json: { k: number } }>`select payload_json from j where id = ${'x'}`
    expect(read.rows[0]?.payload_json).toEqual({ k: 1 })
  })
})
