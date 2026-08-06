/**
 * Cell filtering for data-row loops.
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
