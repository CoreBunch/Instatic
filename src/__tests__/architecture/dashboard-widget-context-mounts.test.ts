import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_ROOT = join(import.meta.dir, '../../admin/pages/dashboard/components')

function countMounts(fileName: string): number {
  const source = readFileSync(join(COMPONENT_ROOT, fileName), 'utf8')
  return source.match(/<DashboardWidgetMount\b/g)?.length ?? 0
}

describe('dashboard widget context mounts', () => {
  it('routes view, customize, and library preview renderers through the shared mount', () => {
    expect(countMounts('DashboardGrid.tsx')).toBe(2)
    expect(countMounts('BlockLibrary.tsx')).toBe(1)
  })
})
