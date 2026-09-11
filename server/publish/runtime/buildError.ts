import type { Page } from '@core/page-tree'
import type { SiteRuntimeDiagnostic } from '@core/site-runtime'

function formatDiagnostic(diagnostic: SiteRuntimeDiagnostic): string {
  const line = diagnostic.line
  const column = diagnostic.column
  const location = diagnostic.path
    ? `${diagnostic.path}${line === undefined ? '' : `:${line}${column === undefined ? '' : `:${column + 1}`}`}`
    : null
  return location ? `${location} — ${diagnostic.message}` : diagnostic.message
}

export class RuntimeScriptBuildError extends Error {
  readonly diagnostics: SiteRuntimeDiagnostic[]
  readonly pageId: string

  constructor(page: Page, diagnostics: SiteRuntimeDiagnostic[]) {
    const details = diagnostics.map(formatDiagnostic).join('; ')
    const pageLabel = page.title || page.slug || page.id
    super(`Runtime script build failed for page "${pageLabel}": ${details}`)
    this.name = 'RuntimeScriptBuildError'
    this.diagnostics = diagnostics
    this.pageId = page.id
  }
}
