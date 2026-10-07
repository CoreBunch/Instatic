import { describe, expect, it } from 'bun:test'
import type { CoreCapability } from '@core/capabilities'
import { selectToolsForScope } from './index'

const FULL: CoreCapability[] = [
  'ai.chat',
  'ai.tools.write',
  'content.create',
  'content.manage',
  'content.edit.any',
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
]

describe('selectToolsForScope', () => {
  it('gives the data scope a way to read back what it wrote', () => {
    const names = selectToolsForScope('data', FULL).map((t) => t.name)

    // All eight data tools.
    expect(names.filter((n) => n.startsWith('data_')).sort()).toEqual([
      'data_add_fields',
      'data_create_rows',
      'data_create_table',
      'data_delete_rows',
      'data_list_tables',
      'data_set_rows_status',
      'data_update_row',
      'data_update_table',
    ])

    // Plus the three content reads that resolve a table id — the data tools
    // write rows but cannot read one back.
    expect(names).toContain('content_get_collection_schema')
    expect(names).toContain('content_list_documents')
    expect(names).toContain('content_get_document')
  })

  it('keeps the borrowed content reads read-only', () => {
    // They arrive from a barrel that stamps `mutates` across its whole set; a
    // read tagged as a write would vanish for a caller without ai.tools.write.
    const borrowed = selectToolsForScope('data', FULL)
      .filter((t) => t.name.startsWith('content_'))
    expect(borrowed).toHaveLength(3)
    expect(borrowed.every((t) => t.mutates !== true)).toBe(true)

    const readOnly = selectToolsForScope('data', ['ai.chat', 'content.manage', 'data.custom.tables.read', 'data.system.tables.read'])
      .map((t) => t.name)
    expect(readOnly).toContain('content_list_documents')
    expect(readOnly).not.toContain('data_create_rows')
  })
})
