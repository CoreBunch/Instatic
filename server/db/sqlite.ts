import { Database } from 'bun:sqlite'
import type { DbClient, DbResult } from './client'

type BindableValue = string | number | null | Uint8Array

/**
 * Convert an arbitrary JS value into something bun:sqlite can bind as a
 * positional parameter.
 *
 * - Plain objects / arrays → JSON.stringify (stored as TEXT)
 * - Date → ISO 8601 string
 * - Uint8Array / Buffer → pass through (stored as BLOB)
 * - boolean → 1 / 0
 * - string, number → pass through
 * - null / undefined → null
 */
function toBindable(value: unknown): BindableValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value as never)
}

/**
 * Expand a tagged template into a positional `?` SQL string plus a params
 * array, applying toBindable to every interpolated value.
 */
function renderTemplate(
  strings: TemplateStringsArray,
  values: unknown[],
): { sql: string; params: BindableValue[] } {
  let sql = ''
  const params: BindableValue[] = []
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i]
    if (i < values.length) {
      sql += '?'
      params.push(toBindable(values[i]))
    }
  }
  return { sql, params }
}

/**
 * Walk every column in a returned row and JSON.parse any column whose name
 * ends in `_json` and whose value is a non-empty string. This keeps the
 * DbClient `_json` read contract dialect-neutral for repository code.
 */
function parseJsonColumns<Row>(row: Row): Row {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (key.endsWith('_json') && typeof value === 'string' && value.length > 0) {
      try {
        result[key] = JSON.parse(value)
      } catch {
        result[key] = value
      }
    } else {
      result[key] = value
    }
  }
  return result as Row
}

/**
 * Returns true for SQL that produces rows: SELECT queries and any statement
 * containing RETURNING (used by INSERT/UPDATE/DELETE … RETURNING in repos).
 */
function isSelectishStatement(sql: string): boolean {
  const trimmed = sql.trimStart()
  return /^select/i.test(trimmed) || /\breturning\b/i.test(sql)
}

export function createSqliteClient(filename: string): DbClient {
  const db = new Database(filename)

  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')

  const fn = (async <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const { sql, params } = renderTemplate(strings, values)
    // db.query() returns a prepared statement cached by the exact SQL string
    // (db.prepare() recompiles on every call). Tagged-template call sites
    // render an identical SQL string per site, so steady-state queries skip
    // compilation entirely; params are still bound fresh on each .all()/.run().
    const stmt = db.query(sql)
    if (isSelectishStatement(sql)) {
      const rows = stmt.all(...params) as Row[]
      return { rows: rows.map(parseJsonColumns), rowCount: rows.length }
    }
    const info = stmt.run(...params)
    return { rows: [], rowCount: info.changes ?? 0 }
  }) as DbClient

  fn.unsafe = async <Row = Record<string, unknown>>(
    rawSql: string,
    params?: unknown[],
  ): Promise<DbResult<Row>> => {
    // Multi-statement migration blocks arrive as a single SQL string with
    // semicolons. db.exec() handles them correctly; a prepared statement
    // (db.query) only runs the first statement.
    if (params === undefined && rawSql.includes(';')) {
      db.exec(rawSql)
      return { rows: [], rowCount: 0 }
    }
    // Cached prepared statement — same rationale as the template path above.
    const stmt = db.query(rawSql)
    const bindParams = (params ?? []).map(toBindable)
    const rows = stmt.all(...bindParams) as Row[]
    return { rows: rows.map(parseJsonColumns), rowCount: rows.length }
  }

  // bun:sqlite is synchronous, but a transaction body may `await` real async
  // work while its BEGIN is still open. Since every statement runs on this one
  // shared connection, two transactions must never overlap — otherwise the
  // second BEGIN throws "cannot start a transaction within a transaction" and
  // its ROLLBACK aborts the first transaction, silently losing committed writes
  // (ISS-040). Serialize them: each transaction runs to completion before the
  // next BEGIN, regardless of whether the previous one committed or threw.
  let txChain: Promise<unknown> = Promise.resolve()
  fn.transaction = <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      // BEGIN is outside the try: if it throws, it propagates without a
      // ROLLBACK (nothing was opened), so a failed BEGIN can never roll back an
      // unrelated transaction. Serialization already guarantees BEGIN never
      // runs while another transaction is open.
      await fn.unsafe('BEGIN')
      try {
        const result = await cb(fn)
        await fn.unsafe('COMMIT')
        return result
      } catch (err) {
        try {
          await fn.unsafe('ROLLBACK')
        } catch {
          // swallow rollback failure — the original error is more important
        }
        throw err
      }
    }
    const result = txChain.then(run, run)
    // Advance the chain on settlement without propagating this transaction's
    // outcome to the next one waiting in line.
    txChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  return Object.assign(fn, { dialect: 'sqlite' as const })
}
