import { describe, expect, it } from 'bun:test'
import { DataRowsSource } from '@core/loops/sources/dataRows'

describe('data.rows loop source', () => {
  it('offers author display fields without exposing user ids as binding fields', () => {
    // `author` is declared, because it is the name an author reaches for and
    // an undeclared key is exactly how a binding to a non-field goes unnoticed.
    expect(DataRowsSource.fields).toContainEqual({
      id: 'author',
      label: 'Author name',
    })
    expect(DataRowsSource.fields).toContainEqual({
      id: 'authorName',
      label: 'Author name (alias)',
    })
    expect(DataRowsSource.fields).toContainEqual({
      id: 'authorRoleName',
      label: 'Author role',
    })
    expect(DataRowsSource.fields.map((field) => field.id)).not.toContain('authorUserId')
    expect(DataRowsSource.fields.map((field) => field.id)).not.toContain('publishedByUserId')
  })

  it('exposes a tableId filter for scoping to a specific data table', () => {
    expect(DataRowsSource.filterSchema).toHaveProperty('tableId')
    expect(DataRowsSource.filterSchema.tableId.type).toBe('select')
  })

  it('offers all expected order-by options', () => {
    const ids = DataRowsSource.orderByOptions.map((o) => o.id)
    expect(ids).toContain('publishedAt')
    expect(ids).toContain('createdAt')
    expect(ids).toContain('updatedAt')
    expect(ids).toContain('slug')
  })
})
