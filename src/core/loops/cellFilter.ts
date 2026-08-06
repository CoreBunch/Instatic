/**
 * Cell access for data-row loops — filtering and ordering by a row's own
 * cell rather than only by the table's SQL columns.
 *
 * A loop could pick a table and an order, but not *which* rows — so a page
 * that should list three featured articles listed the three most recent
 * ones instead. This adds one condition on a row's own cell, which is what
 * "featured", "show on homepage" or "category = X" style lists need.
 *
 * The value lives inside `cells_json`, so the comparison needs JSON access —
 * the one place the two dialects genuinely differ. `cellFilterSql` isolates
 * that behind the same `db.dialect` switch `positionalParam` already uses;
 * everything else (parsing, validation, the closed operator set) is pure and
 * unit-tested here.
 *
 * Deliberately ONE condition, not a query builder: it covers the real cases
 * without inventing an AND/OR grammar the editor cannot express and future
 * maintainers would have to keep sound.
 */

// ---------------------------------------------------------------------------
// Ordering by a cell
// ---------------------------------------------------------------------------

/** `orderBy` values of this shape sort by a cell instead of a column. */
export const CELL_ORDER_PREFIX = 'cell:'

/**
 * Read a cell-ordering request out of a loop's `orderBy`.
 *
 * Riding on `orderBy` (rather than a second prop) keeps ordering in one
 * place: callers that already thread `orderBy` — the publisher, the canvas
 * preview endpoint, imported `data-order-by` attributes — get this for free.
 */
export function parseCellOrder(orderBy: string): { field: string } | null {
  if (!orderBy.startsWith(CELL_ORDER_PREFIX)) return null
  const field = orderBy.slice(CELL_ORDER_PREFIX.length).trim()
  return field ? { field } : null
}

/**
 * `ORDER BY` expression for a cell, with the field name bound as a parameter.
 *
 * Values are compared as TEXT in both dialects. ISO dates — the reason this
 * exists — sort chronologically that way, and text sorts naturally. Numbers
 * sort lexicographically (`'10' < '9'`), which is the price of one predictable
 * rule across Postgres and SQLite instead of two subtly different ones.
 */
export function cellOrderSql(input: {
  field: string
  dialect: 'postgres' | 'sqlite'
  column: string
  paramIndex: number
}): { sql: string; params: unknown[] } {
  const { field, dialect, column, paramIndex } = input
  const placeholder = dialect === 'postgres' ? `$${paramIndex}` : '?'
  const raw = dialect === 'postgres'
    ? `(${column} #>> array[${placeholder}])`
    : `cast(json_extract(${column}, '$.' || ${placeholder}) as text)`
  // `coalesce` keeps rows that lack the field in one predictable place instead
  // of relying on NULL ordering, which differs between the engines.
  return { sql: `coalesce(${raw}, '')`, params: [field] }
}

/** Operators a loop filter can use. Closed set — never interpolated raw. */
export const CELL_FILTER_OPERATORS = ['is', 'isNot', 'isTrue', 'isFalse', 'isSet', 'isEmpty'] as const

export type CellFilterOperator = (typeof CELL_FILTER_OPERATORS)[number]

export interface CellFilter {
  /** Field id as stored in `cells_json` (a data-table field id). */
  field: string
  operator: CellFilterOperator
  /** Compared value for `is` / `isNot`; ignored by the other operators. */
  value: string
}

/** Operators that ignore the comparison value. */
const VALUELESS: ReadonlySet<CellFilterOperator> = new Set(['isTrue', 'isFalse', 'isSet', 'isEmpty'])

export function isCellFilterOperator(value: unknown): value is CellFilterOperator {
  return typeof value === 'string' && (CELL_FILTER_OPERATORS as readonly string[]).includes(value)
}

/**
 * Read a filter out of a loop's free-form `filters` bag.
 *
 * Returns null whenever the filter is absent or unusable, so a half-configured
 * loop (field picked, operator not yet) keeps listing everything instead of
 * silently returning nothing.
 */
export function parseCellFilter(filters: Record<string, unknown>): CellFilter | null {
  const field = typeof filters.cellField === 'string' ? filters.cellField.trim() : ''
  if (!field) return null

  const operator: CellFilterOperator = isCellFilterOperator(filters.cellOperator)
    ? filters.cellOperator
    : 'is'

  const rawValue = filters.cellValue
  const value = typeof rawValue === 'string'
    ? rawValue.trim()
    : typeof rawValue === 'number' || typeof rawValue === 'boolean'
      ? String(rawValue)
      : ''

  // `is` / `isNot` without a value would filter on the empty string, which is
  // never what an author means — treat it as "not configured yet".
  if (!VALUELESS.has(operator) && !value) return null

  return { field, operator, value }
}

/**
 * SQL fragment + parameters for a cell filter.
 *
 * `column` is the qualified JSON column (`data_rows.cells_json` or
 * `data_row_versions.cells_json`). `nextParamIndex` is the 1-based index the
 * first parameter of this fragment takes in the statement's parameter list;
 * `placeholder` renders it in the dialect's own style.
 *
 * The field NAME is a parameter too — never string-concatenated into the SQL —
 * so a crafted field id cannot escape into the statement.
 */
export function cellFilterSql(input: {
  filter: CellFilter
  dialect: 'postgres' | 'sqlite'
  column: string
  nextParamIndex: number
}): { sql: string; params: unknown[] } {
  const { filter, dialect, column, nextParamIndex } = input
  const placeholder = (offset: number) =>
    dialect === 'postgres' ? `$${nextParamIndex + offset}` : '?'

  // Postgres: `cells_json #>> array[key]` reads a text value at a dynamic key.
  // SQLite: `json_extract(cells_json, '$.' || key)` does the same. Both take
  // the key as a bound parameter.
  //
  // Two shapes matter here:
  //   - The expression appears EXACTLY ONCE per fragment. Repeating it would
  //     repeat its placeholder, and the caller binds the field name once.
  //     `coalesce(…, '')` folds the missing-field case into the comparison
  //     instead of needing a second `is null` branch.
  //   - Booleans do not read back identically: Postgres yields 'true'/'false'
  //     text, SQLite's json_extract yields the INTEGERS 1/0. SQLite compares
  //     across storage classes by class first, so `1 = '1'` is false — hence
  //     the cast, and hence the operators accepting both spellings.
  const rawValue = dialect === 'postgres'
    ? `(${column} #>> array[${placeholder(0)}])`
    : `cast(json_extract(${column}, '$.' || ${placeholder(0)}) as text)`
  const textValue = `coalesce(${rawValue}, '')`

  switch (filter.operator) {
    case 'is':
      return { sql: `${textValue} = ${placeholder(1)}`, params: [filter.field, filter.value] }
    case 'isNot':
      // A row missing the field is "not X" — the coalesce keeps it in.
      return { sql: `${textValue} <> ${placeholder(1)}`, params: [filter.field, filter.value] }
    case 'isTrue':
      return { sql: `${textValue} in ('true', '1')`, params: [filter.field] }
    case 'isFalse':
      // Unchecked includes rows where the field was never set.
      return { sql: `${textValue} in ('false', '0', '')`, params: [filter.field] }
    case 'isSet':
      return { sql: `${textValue} <> ''`, params: [filter.field] }
    case 'isEmpty':
      return { sql: `${textValue} = ''`, params: [filter.field] }
  }
}

/**
 * The same predicate in TypeScript, for callers holding rows rather than a
 * query — the canvas preview and any future in-memory path. Keeping it beside
 * the SQL keeps the two definitions honest about each other.
 */
export function cellFilterMatches(filter: CellFilter, cells: Record<string, unknown>): boolean {
  const raw = cells[filter.field]
  const text = raw === null || raw === undefined
    ? null
    : typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : JSON.stringify(raw)

  // Mirrors the SQL exactly: a missing cell reads as the empty string, and
  // the checked/unchecked operators accept both boolean spellings.
  const value = text ?? ''
  switch (filter.operator) {
    case 'is': return value === filter.value
    case 'isNot': return value !== filter.value
    case 'isTrue': return value === 'true' || value === '1'
    case 'isFalse': return value === 'false' || value === '0' || value === ''
    case 'isSet': return value !== ''
    case 'isEmpty': return value === ''
  }
}
