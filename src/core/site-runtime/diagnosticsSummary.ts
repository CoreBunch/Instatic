/**
 * Grouping runtime-script diagnostics for the surfaces that report them: the
 * publish gate, which needs one total plus a readable breakdown, and the
 * Site Explorer, which needs per-file counts to badge a row.
 *
 * Pure logic over `SiteRuntimeDiagnostic[]`; the build that produces them
 * lives in `validateCmsRuntimeScripts`.
 */
import type { SiteRuntimeDiagnostic } from './schemas'

/** Every diagnostic attached to one file, worst-first. */
export interface FileRuntimeDiagnostics {
  fileId: string
  /** Site-relative path, when the diagnostic carried one. */
  path: string | null
  errors: number
  warnings: number
  diagnostics: SiteRuntimeDiagnostic[]
}

export interface RuntimeDiagnosticsSummary {
  errors: number
  warnings: number
  /** One entry per file that has at least one diagnostic, most errors first. */
  files: FileRuntimeDiagnostics[]
  /** Diagnostics the build could not attribute to a file (config, resolution). */
  siteWide: SiteRuntimeDiagnostic[]
}

const SEVERITY_ORDER: Record<SiteRuntimeDiagnostic['severity'], number> = { error: 0, warning: 1, info: 2 }

/** Errors before warnings before info; within a severity, source order by line. */
function bySeverityThenPosition(a: SiteRuntimeDiagnostic, b: SiteRuntimeDiagnostic): number {
  const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  if (severity !== 0) return severity
  return (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0)
}

export function summarizeRuntimeDiagnostics(
  diagnostics: readonly SiteRuntimeDiagnostic[],
): RuntimeDiagnosticsSummary {
  const byFile = new Map<string, FileRuntimeDiagnostics>()
  const siteWide: SiteRuntimeDiagnostic[] = []
  let errors = 0
  let warnings = 0

  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') errors++
    else if (diagnostic.severity === 'warning') warnings++

    // A diagnostic with no `fileId` cannot badge a row; it still belongs in the
    // publish-gate breakdown, so it is kept rather than dropped.
    if (!diagnostic.fileId) {
      siteWide.push(diagnostic)
      continue
    }
    const entry = byFile.get(diagnostic.fileId) ?? {
      fileId: diagnostic.fileId,
      path: diagnostic.path ?? null,
      errors: 0,
      warnings: 0,
      diagnostics: [],
    }
    if (diagnostic.severity === 'error') entry.errors++
    else if (diagnostic.severity === 'warning') entry.warnings++
    entry.path = entry.path ?? diagnostic.path ?? null
    entry.diagnostics.push(diagnostic)
    byFile.set(diagnostic.fileId, entry)
  }

  for (const entry of byFile.values()) entry.diagnostics.sort(bySeverityThenPosition)
  siteWide.sort(bySeverityThenPosition)

  const files = [...byFile.values()].sort(
    (a, b) => b.errors - a.errors || b.warnings - a.warnings || (a.path ?? '').localeCompare(b.path ?? ''),
  )
  return { errors, warnings, files, siteWide }
}

/** What one Explorer row needs: the counts for its own file, or null when it is clean. */
export function fileDiagnostics(
  summary: RuntimeDiagnosticsSummary,
  fileId: string,
): FileRuntimeDiagnostics | null {
  return summary.files.find((entry) => entry.fileId === fileId) ?? null
}
