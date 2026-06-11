/**
 * `nextDataRowVersionNumber` is the single allocator of `data_row_versions`
 * version numbers. Both publish paths — the per-row publish persistence
 * (`repositories/data/publish.ts`) and the whole-site publish orchestrator
 * (`server/publish/publishSite.ts`) — must route through it so the
 * "next = max(existing) + 1" invariant has exactly one home.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { nextDataRowVersionNumber } from '../../../server/repositories/data'
import { createFakeDb } from './dbTestFake'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const read = (rel: string) => readFileSync(repoRoot + rel, 'utf8')

describe('nextDataRowVersionNumber', () => {
  it('allocates max(version_number) + 1 for the given row', async () => {
    let capturedSql = ''
    let capturedParams: unknown[] = []
    const db = createFakeDb(async (sql, params) => {
      capturedSql = sql
      capturedParams = params
      // simulate three existing versions for the row
      return { rows: [{ next_version: 4 }], rowCount: 1 }
    })

    const next = await nextDataRowVersionNumber(db, 'row-123')

    expect(next).toBe(4)
    expect(capturedParams).toEqual(['row-123'])
    const normalized = capturedSql.replace(/\s+/g, ' ').toLowerCase()
    expect(normalized).toContain('coalesce(max(version_number), 0) + 1')
    expect(normalized).toContain('from data_row_versions')
    expect(normalized).toContain('where row_id = $1')
  })

  it('returns 1 when the row has no versions yet', async () => {
    const db = createFakeDb(async () => ({ rows: [{ next_version: 1 }], rowCount: 1 }))
    expect(await nextDataRowVersionNumber(db, 'fresh-row')).toBe(1)
  })

  it('returns 1 when the query yields no rows', async () => {
    const db = createFakeDb(async () => ({ rows: [], rowCount: 0 }))
    expect(await nextDataRowVersionNumber(db, 'fresh-row')).toBe(1)
  })
})

describe('single version allocator across publish paths', () => {
  const publishPaths = [
    'server/publish/publishSite.ts',
    'server/repositories/data/publish.ts',
  ]

  it('both publish modules call the shared allocator', () => {
    for (const path of publishPaths) {
      expect(read(path)).toContain('nextDataRowVersionNumber')
    }
  })

  it('no publish module defines its own version-number query', () => {
    // The allocator lives only in data/versions.ts — any second copy of the
    // coalesce(max(version_number)) query in a publish module is drift.
    for (const path of publishPaths) {
      const src = read(path).replace(/\s+/g, ' ').toLowerCase()
      expect(src).not.toContain('coalesce(max(version_number)')
    }
    const allocator = read('server/repositories/data/versions.ts').replace(/\s+/g, ' ').toLowerCase()
    expect(allocator).toContain('coalesce(max(version_number), 0) + 1')
  })
})
