import type { DbClient, DbResult } from '../../../server/db'

/**
 * Reconstruct positional-parameter SQL from a tagged-template call.
 * Used by test fakes that simulate the database by inspecting the SQL string.
 */
function reconstructSql(
  strings: TemplateStringsArray,
  values: unknown[],
): { sql: string; params: unknown[] } {
  let sql = strings[0]
  for (let i = 0; i < values.length; i++) {
    sql += `$${i + 1}` + strings[i + 1]
  }
  return { sql, params: values }
}

/**
 * Build a fake DbClient from a positional-style query handler. Gives test
 * fakes the same SQL-parsing logic they had before, while satisfying the
 * tagged-template DbClient interface and supporting `.transaction()` and
 * `.unsafe()`.
 */
export function createFakeDb(
  handler: (sql: string, params: unknown[]) => Promise<DbResult>,
): DbClient {
  const fn = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { sql, params } = reconstructSql(strings, values)
    return handler(sql, params)
  }) as DbClient
  fn.unsafe = async (sql: string, params: unknown[] = []) => handler(sql, params)
  fn.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> => cb(fn)
  // No resource to release; present so fakes satisfy DbClient at runtime, not
  // only through the `as DbClient` assertion.
  fn.close = async (): Promise<void> => {}
  return Object.assign(fn, { dialect: 'sqlite' as const })
}

/**
 * The public router asks, once per publish version, which published routes
 * are protected (`server/publish/accessGate.ts`). Fixtures that stub the
 * database by SQL text have no protected routes: answer those reads with
 * no rows. Pass the SQL lower-cased and whitespace-collapsed.
 */
export function answerAccessIndexRead(sql: string): DbResult | undefined {
  const isPageRead = sql.includes('data_row_versions.cells_json') && sql.includes("data_rows.table_id = 'pages'")
  const isTableRead = sql.includes('access_json') && sql.includes('from data_tables')
  // The slug → id map entry-template targets are resolved through.
  const isTableSlugRead = sql.includes('select logical_id, slug') && sql.includes('from data_tables')
  return isPageRead || isTableRead || isTableSlugRead ? { rows: [], rowCount: 0 } : undefined
}
