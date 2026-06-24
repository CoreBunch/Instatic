import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dataTableCss = readFileSync(
  join(import.meta.dir, '../../ui/components/DataTable/DataTable.module.css'),
  'utf8',
)

describe('DataTable visual density', () => {
  it('uses 1px row spacing and editor-surface-2 hover for every table density', () => {
    expect(dataTableCss).toContain('border-spacing: 0 1px')
    expect(dataTableCss).toContain('.row:hover .cell')
    expect(dataTableCss).toContain('background: var(--bg-surface-2)')
    expect(dataTableCss).not.toContain('border-spacing: 0 4px')
    expect(dataTableCss).not.toContain('border-spacing: 0 8px')
  })
})
