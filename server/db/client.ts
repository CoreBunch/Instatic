export interface DbResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount: number
}

/** Which SQL dialect the backing database speaks. */
export type Dialect = 'postgres' | 'sqlite'

/**
 * Dialect-aware positional placeholder for `db.unsafe()` SQL strings.
 * Postgres uses `$1, $2, …`; SQLite uses a bare `?`. This is the canonical
 * home for the helper — repositories that splice shared column lists into
 * `db.unsafe()` (see `DATA_ROW_COLUMNS`, `USER_JOINED_COLUMNS`) build their
 * WHERE clauses through it so the same SQL string works on both dialects.
 */
export function placeholder(dialect: Dialect, index: number): string {
  return dialect === 'postgres' ? `$${index}` : '?'
}

/**
 * The shared DB client interface. Used by repositories and handlers.
 * Tagged-template callable returning DbResult, plus:
 *   - .unsafe(...) — execute raw SQL strings (e.g. stored migration blocks)
 *   - .transaction(fn) — runs a callback inside a DB transaction
 *   - .close()      — release the underlying handle or connection pool
 *   - .dialect      — which SQL dialect the backing database speaks
 */
export interface DbClient {
  <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>>
  unsafe<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<DbResult<Row>>
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>
  /**
   * Release the backing resource: the SQLite file handle (and its WAL/SHM
   * siblings) or the Postgres connection pool. Queries issued after close
   * reject. Long-lived server clients never call this; it exists for callers
   * with a bounded lifetime, chiefly test teardown, which must release the
   * handle before deleting the database file. Windows refuses to unlink a
   * file that is still open, so leaving it to garbage collection is not
   * portable.
   *
   * On a transaction-scoped client (the `tx` passed to `.transaction()`)
   * this is a no-op: the enclosing client owns the resource.
   */
  close(): Promise<void>
  readonly dialect: Dialect
}
