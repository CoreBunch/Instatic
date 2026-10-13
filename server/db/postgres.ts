import { SQL } from 'bun'
import type { DbClient, DbResult } from './client'

export function createPostgresClient(connectionString: string): DbClient {
  const sql = new SQL(connectionString)
  return wrapSql(sql, true)
}

/**
 * Walk every column in a returned row and normalize dialect-specific values:
 *
 * - Date instances become ISO 8601 strings, matching SQLite timestamp reads.
 * - String-valued `*_json` columns are JSON.parsed, matching SQLite's TEXT
 *   JSON hydration and covering PG columns that intentionally store JSON in
 *   text rather than jsonb.
 */
export function normalizePostgresRow<Row>(row: Row): Row {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    const normalized = value instanceof Date ? value.toISOString() : value
    if (key.endsWith('_json') && typeof normalized === 'string' && normalized.length > 0) {
      try {
        result[key] = JSON.parse(normalized)
      } catch {
        result[key] = normalized
      }
    } else {
      result[key] = normalized
    }
  }
  return result as Row
}

/**
 * Affected-or-returned row count for a Bun SQL result.
 *
 * Bun exposes the command's row count on the result array's `.count` property:
 * for SELECT / RETURNING it equals the number of returned rows, and for a
 * non-RETURNING UPDATE / DELETE / INSERT it is the number of *affected* rows
 * (which PostgreSQL streams as a CommandComplete tag, not as data rows — so
 * `result.length` is 0 there). Using `.count` makes `rowCount` mean the same
 * thing as the SQLite adapter's `info.changes`. Falls back to `length` if the
 * property is ever absent.
 */
function resultRowCount<Row>(result: Row[]): number {
  const count = (result as { count?: unknown }).count
  return typeof count === 'number' ? count : result.length
}

/**
 * Wrap a Bun SQL handle in the DbClient interface.
 *
 * `ownsPool` distinguishes the client returned by `createPostgresClient`,
 * which owns the connection pool, from the transaction-scoped client handed
 * to a `.transaction()` callback, which borrows it. Only the owner may close
 * the pool; closing it mid-transaction would tear the connection out from
 * under the surrounding `sql.begin()`.
 */
function wrapSql(sql: SQL, ownsPool = false): DbClient {
  /**
   * Convert an interpolated JS value into something Bun.sql can bind for
   * Postgres, mirroring SQLite's toBindable so `*_json` columns round-trip
   * identically on both dialects.
   *
   * - Plain objects / arrays → JSON.stringify (stored as TEXT)
   * - Date → ISO 8601 string
   * - Uint8Array / Buffer → pass through (bound to bytea)
   * - string, number → pass through
   * - null / undefined → null
   */
  const serialize = (value: unknown): unknown => {
    if (value === null || value === undefined) return null
    if (value instanceof Uint8Array) return value
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'object') return JSON.stringify(value)
    return value
  }

  const fn = (async <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const rows = await sql<Row[]>(strings, ...values.map(serialize))
    return { rows: rows.map(normalizePostgresRow), rowCount: resultRowCount(rows) }
  }) as DbClient

  fn.unsafe = async <Row = Record<string, unknown>>(
    rawSql: string,
    params?: unknown[],
  ): Promise<DbResult<Row>> => {
    const rows = params !== undefined
      ? await sql.unsafe<Row[]>(rawSql, params.map(serialize))
      : await sql.unsafe<Row[]>(rawSql)
    return { rows: rows.map(normalizePostgresRow), rowCount: resultRowCount(rows) }
  }

  fn.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> => {
    return await sql.begin(async (txSql) => cb(wrapSql(txSql as unknown as SQL)))
  }

  fn.close = async (): Promise<void> => {
    if (!ownsPool) return
    await sql.close()
  }

  return Object.assign(fn, { dialect: 'postgres' as const })
}
