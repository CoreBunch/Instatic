/**
 * Dialect-aware JSON field extraction helper.
 *
 * Produces SQL fragments for extracting a scalar field from a JSON column,
 * normalised across the two supported dialects:
 *
 *   Postgres : `column->>'field'`          (jsonb text extraction operator)
 *   SQLite   : `json_extract(column, '$.field')`
 *
 * Usage:
 *   const expr = jsonField('settings_json', 'theme', db.dialect)
 *   // Pass expr.sql into a db.unsafe() call's SQL string; keep values parameterised.
 *
 * The returned `JsonFieldExpr` is a frozen, branded object. Callers cannot
 * construct one directly — they must go through `jsonField`, which validates
 * both identifiers. This prevents arbitrary SQL from being smuggled through the
 * helper's escape hatch.
 *
 * @see server/db/client.ts — DbClient.dialect
 * @see src/__tests__/architecture/json-extract-egress.test.ts — egress gate
 */

import type { Dialect } from './client'

// Re-export Dialect so callers can import it from this module alongside JsonFieldExpr.


/**
 * Branded SQL fragment produced by `jsonField`.
 * The `.sql` string is safe for insertion into `db.unsafe()` SQL because it
 * was validated and constructed exclusively by `jsonField`. Values are kept
 * parameterised by the caller.
 */
type JsonFieldExpr = { readonly __brand: 'JsonFieldExpr'; readonly sql: string }

/** Column and field names must be plain ASCII identifiers — no dots, no quotes, no hyphens. */
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * Build a dialect-correct SQL fragment that extracts a scalar text value from
 * a JSON column.
 *
 * @param column  - The SQL column name (must match /^[a-zA-Z_][a-zA-Z0-9_]*$/).
 * @param field   - The top-level JSON key to extract (same identifier rules).
 * @param dialect - Which SQL dialect to emit (`db.dialect`).
 * @returns A frozen `JsonFieldExpr` whose `.sql` may be spliced into a `db.unsafe()` call.
 * @throws If either identifier fails validation.
 *
 * @example
 *   const expr = jsonField('settings_json', 'theme', db.dialect)
 *   const result = await db.unsafe(
 *     `SELECT id FROM installed_plugins WHERE ${expr.sql} = ?`,
 *     [themeValue],
 *   )
 */
export function jsonField(column: string, field: string, dialect: Dialect): JsonFieldExpr {
  if (!IDENT_RE.test(column)) {
    throw new Error(`[db/jsonExtract] invalid column identifier: ${column}`)
  }
  if (!IDENT_RE.test(field)) {
    throw new Error(`[db/jsonExtract] invalid field identifier: ${field}`)
  }
  const sql =
    dialect === 'postgres'
      ? `${column}->>'${field}'`
      : `json_extract(${column}, '$.${field}')`
  return Object.freeze({ __brand: 'JsonFieldExpr', sql } as const)
}

/** The JSON scalar types a typed comparison can target. */
export type JsonScalarKind = 'text' | 'number' | 'boolean'

/**
 * Like `jsonField`, but the fragment yields a value of ONE JSON type and NULL
 * for every row whose field holds another type (or nothing). That is what
 * makes a comparison mean the same on both dialects:
 *
 *   - Postgres `->>` always yields text, so comparing it with a bound number
 *     or boolean is an error ("operator does not exist: text = integer") and
 *     ordering by it sorts numbers as text. Here a number is cast to `numeric`
 *     and a boolean to `boolean`, guarded by `jsonb_typeof` so a row holding
 *     another type never reaches the cast.
 *   - SQLite `json_extract` yields a typed value but reports `true` as `1`, so
 *     a number filter would match booleans. Here `json_type` guards the type.
 *
 * Text compares byte-wise on both (`collate "C"` on Postgres, SQLite's default
 * BINARY), so `gt` / `lt` and ordering do not depend on the database locale.
 * Bind a `'boolean'` comparison through `jsonBooleanParam`.
 */
export function jsonFieldTyped(
  column: string,
  field: string,
  dialect: Dialect,
  kind: JsonScalarKind,
): JsonFieldExpr {
  const text = jsonField(column, field, dialect).sql
  let sql: string
  if (dialect === 'postgres') {
    const type = `jsonb_typeof(${column}->'${field}')`
    sql =
      kind === 'number'
        ? `(case when ${type} = 'number' then (${text})::numeric end)`
        : kind === 'boolean'
          ? `(case when ${type} = 'boolean' then (${text})::boolean end)`
          : `(case when ${type} = 'string' then ${text} end) collate "C"`
  } else {
    const type = `json_type(${column}, '$.${field}')`
    sql =
      kind === 'number'
        ? `(case when ${type} in ('integer', 'real') then ${text} end)`
        : kind === 'boolean'
          ? `(case when ${type} in ('true', 'false') then ${text} end)`
          : `(case when ${type} = 'text' then ${text} end)`
  }
  return Object.freeze({ __brand: 'JsonFieldExpr', sql } as const)
}

/** The value to bind against a `'boolean'` `jsonFieldTyped` fragment. */
export function jsonBooleanParam(value: boolean, dialect: Dialect): boolean | number {
  // SQLite has no boolean type: json_extract reports true/false as 1/0.
  return dialect === 'postgres' ? value : value ? 1 : 0
}

/**
 * ORDER BY terms that sort a JSON field the same way on both dialects:
 * rows without the field (or holding null) first, then booleans (false before
 * true), then numbers by value, then text byte-wise, then arrays and objects
 * in no defined order. `desc` reverses the whole sequence.
 *
 * Without this, Postgres orders `->>` as text ("10" before "9") and puts
 * missing values last, while SQLite orders by type and puts them first.
 */
export function jsonFieldOrder(
  column: string,
  field: string,
  dialect: Dialect,
  direction: 'asc' | 'desc',
): JsonFieldExpr {
  const number = jsonFieldTyped(column, field, dialect, 'number').sql
  const text = jsonFieldTyped(column, field, dialect, 'text').sql
  const rank =
    dialect === 'postgres'
      ? `(case coalesce(jsonb_typeof(${column}->'${field}'), 'null') when 'null' then 0 when 'boolean' then 1 when 'number' then 2 when 'string' then 3 else 4 end)`
      : `(case coalesce(json_type(${column}, '$.${field}'), 'null') when 'null' then 0 when 'true' then 1 when 'false' then 1 when 'integer' then 2 when 'real' then 2 when 'text' then 3 else 4 end)`
  const bool =
    dialect === 'postgres'
      ? `(case when jsonb_typeof(${column}->'${field}') = 'boolean' and ${jsonField(column, field, dialect).sql} = 'true' then 1 else 0 end)`
      : `(case when json_type(${column}, '$.${field}') = 'true' then 1 else 0 end)`
  const sql = [rank, bool, number, text].map((term) => `${term} ${direction}`).join(', ')
  return Object.freeze({ __brand: 'JsonFieldExpr', sql } as const)
}

/**
 * A case-insensitive LIKE on a JSON text field that means the same on both
 * dialects: only ASCII letters fold (`'ÉCOLE'` matches `'École'`, but `É`
 * and `é` stay different letters), `%` and `_` are the
 * wildcards and a backslash escapes them. `param` is the placeholder of the
 * bound pattern.
 *
 * On Postgres `lower()` follows the collation of its argument, so the field
 * (compared under `"C"`) and the pattern (the database locale) would fold
 * differently; both sides are lowered under `"C"` here. SQLite's `lower()`
 * folds ASCII only, which is the behaviour being matched.
 */
export function jsonTextLike(column: string, field: string, dialect: Dialect, param: string): JsonFieldExpr {
  const text = jsonFieldTyped(column, field, dialect, 'text').sql
  const sql =
    dialect === 'postgres'
      ? `lower(${text}) like lower(cast(${param} as text) collate "C") escape '\\'`
      : `lower(${text}) like lower(${param}) escape '\\'`
  return Object.freeze({ __brand: 'JsonFieldExpr', sql } as const)
}

/** A condition that is true when the JSON column holds an object. */
export function jsonColumnIsObject(column: string, dialect: Dialect): JsonFieldExpr {
  if (!IDENT_RE.test(column)) {
    throw new Error(`[db/jsonExtract] invalid column identifier: ${column}`)
  }
  const sql =
    dialect === 'postgres'
      ? `jsonb_typeof(${column}) = 'object'`
      : `(json_valid(${column}) and json_type(${column}) = 'object')`
  return Object.freeze({ __brand: 'JsonFieldExpr', sql } as const)
}

// DbClient is imported as a type so that downstream code can write
// convenience wrappers that accept a DbClient and read its .dialect.
// The import is type-only and erased at runtime; it does not create a
// circular dependency.

