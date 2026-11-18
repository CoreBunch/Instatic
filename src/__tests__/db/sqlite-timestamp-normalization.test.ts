import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createSqliteClient } from '../../../server/db/sqlite'
import type { DbClient } from '../../../server/db/client'

/**
 * SQLite's `current_timestamp` yields `YYYY-MM-DD HH:MM:SS` in UTC with no
 * `T` separator and no zone marker. V8 parses that shape as *local* time, so
 * on a server running in UTC+2 a row updated a second ago read as "updated
 * 2h ago" in the admin. The adapter must hand repositories ISO 8601 UTC
 * strings for `*_at` columns, the same shape the Postgres adapter derives
 * from `timestamptz`.
 *
 * The process is pinned to a non-UTC zone for the duration of this file so
 * the naive parse actually diverges; Bun re-reads `process.env.TZ` at runtime.
 */
describe('SQLite adapter — *_at columns read back as ISO 8601 UTC', () => {
  const originalTz = process.env['TZ']
  let db: DbClient

  beforeAll(async () => {
    process.env['TZ'] = 'Europe/Prague'
    db = createSqliteClient(':memory:')
    await db`
      create table ts_probe (
        id integer primary key,
        title text,
        touched_at text,
        updated_at text not null default current_timestamp
      )`
  })

  afterAll(async () => {
    await db.close()
    if (originalTz === undefined) delete process.env['TZ']
    else process.env['TZ'] = originalTz
  })

  test('precondition: the process runs in a non-UTC zone', () => {
    // July is CEST (UTC+2); getTimezoneOffset() reports minutes behind UTC.
    expect(new Date('2026-07-01T00:00:00').getTimezoneOffset()).toBe(-120)
  })

  test('a row stamped by current_timestamp reads back as now, not shifted by the zone', async () => {
    const before = Date.now()
    const { rows } = await db<{ updated_at: string; raw: string }>`
      insert into ts_probe (id, title) values (1, 'a')
      returning updated_at, updated_at as raw`

    // The alias is not a *_at column, so it keeps SQLite's own shape — the
    // exact string V8 misreads as local time.
    const raw = rows[0]!.raw
    expect(raw).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(Math.abs(Date.parse(raw) - before)).toBeGreaterThanOrEqual(60 * 60 * 1000)

    const normalized = rows[0]!.updated_at
    expect(normalized).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Math.abs(Date.parse(normalized) - before)).toBeLessThan(5_000)
  })

  test('rewrites the SQLite shape to ISO 8601 UTC, fractional seconds included', async () => {
    await db`insert into ts_probe (id, title, touched_at) values (2, 'b', '2026-09-11 10:00:00')`
    await db`insert into ts_probe (id, title, touched_at) values (3, 'c', '2026-09-11 10:00:00.123')`

    const { rows } = await db<{ touched_at: string }>`
      select touched_at from ts_probe where id in (2, 3) order by id`
    expect(rows.map((r) => r.touched_at)).toEqual([
      '2026-09-11T10:00:00.000Z',
      '2026-09-11T10:00:00.123Z',
    ])
  })

  test('leaves ISO strings, nulls, and non-timestamp values in *_at columns alone', async () => {
    await db`insert into ts_probe (id, title, touched_at) values (4, 'd', '2026-09-11T10:00:00.000Z')`
    await db`insert into ts_probe (id, title, touched_at) values (5, 'e', null)`
    await db`insert into ts_probe (id, title, touched_at) values (6, 'f', 'never')`

    const { rows } = await db<{ touched_at: string | null }>`
      select touched_at from ts_probe where id in (4, 5, 6) order by id`
    expect(rows.map((r) => r.touched_at)).toEqual(['2026-09-11T10:00:00.000Z', null, 'never'])
  })

  test('only *_at columns are rewritten: a title that looks like a timestamp is data', async () => {
    await db`insert into ts_probe (id, title) values (7, '2026-09-11 10:00:00')`

    const { rows } = await db<{ title: string }>`select title from ts_probe where id = 7`
    expect(rows[0]!.title).toBe('2026-09-11 10:00:00')
  })

  test('unsafe() reads go through the same normalisation', async () => {
    const { rows } = await db.unsafe<{ touched_at: string }>(
      'select touched_at from ts_probe where id = ?',
      [2],
    )
    expect(rows[0]!.touched_at).toBe('2026-09-11T10:00:00.000Z')
  })
})
