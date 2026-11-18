import { describe, expect, it } from 'bun:test'
import { fileDiagnostics, summarizeRuntimeDiagnostics } from '@core/site-runtime'
import type { SiteRuntimeDiagnostic } from '@core/site-runtime'

function diagnostic(partial: Partial<SiteRuntimeDiagnostic>): SiteRuntimeDiagnostic {
  return { code: 'build-failed', severity: 'error', message: 'boom', ...partial }
}

describe('summarizeRuntimeDiagnostics', () => {
  it('counts errors and warnings and groups them per file', () => {
    const summary = summarizeRuntimeDiagnostics([
      diagnostic({ fileId: 'a', path: 'src/scripts/a.ts', line: 3 }),
      diagnostic({ fileId: 'a', path: 'src/scripts/a.ts', line: 1 }),
      diagnostic({ fileId: 'b', path: 'src/scripts/b.ts', severity: 'warning' }),
    ])
    expect(summary.errors).toBe(2)
    expect(summary.warnings).toBe(1)
    expect(summary.files.map((f) => f.fileId)).toEqual(['a', 'b'])
    expect(summary.files[0].errors).toBe(2)
    // Within a file the earlier line reads first, so the list matches the source.
    expect(summary.files[0].diagnostics.map((d) => d.line)).toEqual([1, 3])
  })

  it('sorts files by severity so the worst offender is first', () => {
    const summary = summarizeRuntimeDiagnostics([
      diagnostic({ fileId: 'warn-only', severity: 'warning' }),
      diagnostic({ fileId: 'broken' }),
      diagnostic({ fileId: 'broken' }),
    ])
    expect(summary.files.map((f) => f.fileId)).toEqual(['broken', 'warn-only'])
  })

  it('keeps diagnostics that name no file instead of dropping them', () => {
    const summary = summarizeRuntimeDiagnostics([diagnostic({ message: 'cannot resolve the import map' })])
    expect(summary.files).toEqual([])
    expect(summary.siteWide).toHaveLength(1)
    // They still count towards the publish gate.
    expect(summary.errors).toBe(1)
  })

  it('puts errors before warnings within one file', () => {
    const summary = summarizeRuntimeDiagnostics([
      diagnostic({ fileId: 'a', severity: 'warning', line: 1 }),
      diagnostic({ fileId: 'a', severity: 'error', line: 9 }),
    ])
    expect(summary.files[0].diagnostics.map((d) => d.severity)).toEqual(['error', 'warning'])
  })

  it('reports a clean build as empty', () => {
    const summary = summarizeRuntimeDiagnostics([])
    expect(summary).toEqual({ errors: 0, warnings: 0, files: [], siteWide: [] })
  })
})

describe('fileDiagnostics', () => {
  it('finds one file and reports null for a clean one', () => {
    const summary = summarizeRuntimeDiagnostics([diagnostic({ fileId: 'a', path: 'src/scripts/a.ts' })])
    expect(fileDiagnostics(summary, 'a')?.path).toBe('src/scripts/a.ts')
    expect(fileDiagnostics(summary, 'clean')).toBeNull()
  })
})
