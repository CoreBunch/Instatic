/**
 * Unit tests for the loop cell filter — the pure half.
 *
 * Two properties matter and both are easy to get wrong:
 *   - a half-configured filter must never silently empty a list, and
 *   - the SQL must bind BOTH the field name and the value, so a field id
 *     can never reach the statement text.
 *
 * The SQL/TypeScript predicates are also checked against each other: they
 * are two spellings of one rule, and the canvas uses one while the
 * publisher uses the other.
 */
import { describe, expect, test } from 'bun:test'
import {
  cellFilterMatches,
  cellFilterSql,
  cellOrderSql,
  parseCellFilter,
  parseCellOrder,
  CELL_FILTER_OPERATORS,
  type CellFilter,
} from '@core/loops/cellFilter'

describe('parseCellFilter', () => {
  test('returns null when no field is chosen', () => {
    expect(parseCellFilter({})).toBeNull()
    expect(parseCellFilter({ cellField: '   ' })).toBeNull()
  })

  test('a comparison without a value is treated as not-yet-configured', () => {
    expect(parseCellFilter({ cellField: 'featured', cellOperator: 'is' })).toBeNull()
    expect(parseCellFilter({ cellField: 'featured', cellOperator: 'isNot', cellValue: '' })).toBeNull()
  })

  test('valueless operators need no value', () => {
    expect(parseCellFilter({ cellField: 'featured', cellOperator: 'isTrue' }))
      .toEqual({ field: 'featured', operator: 'isTrue', value: '' })
  })

  test('defaults to `is` and coerces non-string values', () => {
    expect(parseCellFilter({ cellField: 'rank', cellValue: 3 }))
      .toEqual({ field: 'rank', operator: 'is', value: '3' })
    expect(parseCellFilter({ cellField: 'live', cellValue: true }))
      .toEqual({ field: 'live', operator: 'is', value: 'true' })
  })

  test('an unknown operator falls back to `is` rather than breaking the query', () => {
    expect(parseCellFilter({ cellField: 'a', cellOperator: 'DROP TABLE', cellValue: 'x' }))
      .toEqual({ field: 'a', operator: 'is', value: 'x' })
  })
})

describe('cellFilterSql', () => {
  const filter: CellFilter = { field: 'team-on-about-page', operator: 'isTrue', value: '' }

  test('binds the field name as a parameter — never as SQL text', () => {
    for (const dialect of ['postgres', 'sqlite'] as const) {
      const { sql, params } = cellFilterSql({ filter, dialect, column: 'data_rows.cells_json', nextParamIndex: 4 })
      expect(sql).not.toContain('team-on-about-page')
      expect(params[0]).toBe('team-on-about-page')
    }
  })

  test('a hostile field id cannot escape into the statement', () => {
    const hostile: CellFilter = { field: "x'); drop table data_rows; --", operator: 'is', value: 'y' }
    const { sql, params } = cellFilterSql({ filter: hostile, dialect: 'sqlite', column: 'c', nextParamIndex: 2 })
    expect(sql).not.toContain('drop table')
    expect(params).toEqual([hostile.field, 'y'])
  })

  test('placeholders follow the dialect and start at the given index', () => {
    const pg = cellFilterSql({ filter: { field: 'f', operator: 'is', value: 'v' }, dialect: 'postgres', column: 'c', nextParamIndex: 4 })
    expect(pg.sql).toContain('$4')
    expect(pg.sql).toContain('$5')
    const sqlite = cellFilterSql({ filter: { field: 'f', operator: 'is', value: 'v' }, dialect: 'sqlite', column: 'c', nextParamIndex: 4 })
    expect(sqlite.sql).toContain('?')
    expect(sqlite.sql).not.toContain('$4')
  })

  test('every operator produces a fragment with the right parameter count', () => {
    const cases: Array<[CellFilter['operator'], number]> = [
      ['is', 2], ['isNot', 2], ['isTrue', 1], ['isFalse', 1], ['isSet', 1], ['isEmpty', 1],
    ]
    for (const [operator, paramCount] of cases) {
      const { sql, params } = cellFilterSql({
        filter: { field: 'f', operator, value: 'v' },
        dialect: 'sqlite',
        column: 'c',
        nextParamIndex: 1,
      })
      expect(sql.length).toBeGreaterThan(0)
      expect(params).toHaveLength(paramCount)
    }
  })

  test('the JSON read appears once per fragment, so the field binds once', () => {
    // Repeating the expression would repeat its placeholder while the caller
    // binds the field name a single time — the bug that made SQLite reject
    // the statement with "expected 3 values, received 2".
    for (const operator of CELL_FILTER_OPERATORS) {
      const { sql, params } = cellFilterSql({
        filter: { field: 'f', operator, value: 'v' },
        dialect: 'sqlite',
        column: 'c',
        nextParamIndex: 1,
      })
      expect(sql.match(/json_extract/g) ?? []).toHaveLength(1)
      expect(sql.match(/\?/g) ?? []).toHaveLength(params.length)
    }
  })

  test('missing cells fold into the comparison instead of vanishing', () => {
    // `coalesce(…, '')` is what keeps a row that never set the field inside
    // "is not X" and "is unchecked".
    for (const operator of ['isNot', 'isFalse', 'isEmpty'] as const) {
      const { sql } = cellFilterSql({
        filter: { field: 'f', operator, value: 'v' },
        dialect: 'sqlite',
        column: 'c',
        nextParamIndex: 1,
      })
      expect(sql).toContain('coalesce')
    }
  })

  test('SQLite casts the JSON read so boolean cells compare as text', () => {
    const { sql } = cellFilterSql({ filter: { field: 'f', operator: 'isTrue', value: '' }, dialect: 'sqlite', column: 'c', nextParamIndex: 1 })
    // Without the cast, json_extract returns INTEGER 1 and `1 = '1'` is false.
    expect(sql).toContain('cast(')
    expect(sql).toContain("'1'")
  })
})

describe('parseCellOrder', () => {
  test('only `cell:` values mean a cell sort', () => {
    expect(parseCellOrder('publishedAt')).toBeNull()
    expect(parseCellOrder('')).toBeNull()
    expect(parseCellOrder('cell:published-on')).toEqual({ field: 'published-on' })
  })

  test('a prefix with no field is not a sort', () => {
    expect(parseCellOrder('cell:')).toBeNull()
    expect(parseCellOrder('cell:   ')).toBeNull()
  })
})

describe('cellOrderSql', () => {
  test('binds the field name and never writes it into the SQL', () => {
    for (const dialect of ['postgres', 'sqlite'] as const) {
      const { sql, params } = cellOrderSql({ field: 'published-on', dialect, column: 'c', paramIndex: 2 })
      expect(sql).not.toContain('published-on')
      expect(params).toEqual(['published-on'])
    }
  })

  test('rows without the field get a defined sort position', () => {
    const { sql } = cellOrderSql({ field: 'f', dialect: 'sqlite', column: 'c', paramIndex: 1 })
    expect(sql).toContain('coalesce')
  })

  test('placeholder style follows the dialect', () => {
    expect(cellOrderSql({ field: 'f', dialect: 'postgres', column: 'c', paramIndex: 3 }).sql).toContain('$3')
    expect(cellOrderSql({ field: 'f', dialect: 'sqlite', column: 'c', paramIndex: 3 }).sql).toContain('?')
  })
})

describe('cellFilterMatches mirrors the SQL semantics', () => {
  const rows = {
    featuredTrue: { featured: true, name: 'A' },
    featuredFalse: { featured: false, name: 'B' },
    missing: { name: 'C' },
    empty: { featured: '', name: 'D' },
  }

  test('isTrue only matches a true value', () => {
    const f: CellFilter = { field: 'featured', operator: 'isTrue', value: '' }
    expect(cellFilterMatches(f, rows.featuredTrue)).toBe(true)
    expect(cellFilterMatches(f, rows.featuredFalse)).toBe(false)
    expect(cellFilterMatches(f, rows.missing)).toBe(false)
  })

  test('isFalse matches false AND a missing field', () => {
    const f: CellFilter = { field: 'featured', operator: 'isFalse', value: '' }
    expect(cellFilterMatches(f, rows.featuredFalse)).toBe(true)
    expect(cellFilterMatches(f, rows.missing)).toBe(true)
    expect(cellFilterMatches(f, rows.featuredTrue)).toBe(false)
  })

  test('is / isNot compare as text', () => {
    expect(cellFilterMatches({ field: 'name', operator: 'is', value: 'A' }, rows.featuredTrue)).toBe(true)
    expect(cellFilterMatches({ field: 'name', operator: 'isNot', value: 'A' }, rows.featuredTrue)).toBe(false)
    expect(cellFilterMatches({ field: 'name', operator: 'isNot', value: 'A' }, rows.featuredFalse)).toBe(true)
  })

  test('isSet / isEmpty treat an empty string as empty', () => {
    expect(cellFilterMatches({ field: 'featured', operator: 'isSet', value: '' }, rows.empty)).toBe(false)
    expect(cellFilterMatches({ field: 'featured', operator: 'isEmpty', value: '' }, rows.empty)).toBe(true)
    expect(cellFilterMatches({ field: 'featured', operator: 'isEmpty', value: '' }, rows.missing)).toBe(true)
  })
})
