/**
 * The one publish failure the author can actually fix.
 *
 * A page's runtime scripts are bundled during publish, and a script importing
 * a package the site never declared is a blocking diagnostic. Everything the
 * author needs is already in it — the package, the file, and by implication
 * what to do — but a bare `throw new Error(...)` reaches the router's generic
 * catch, which deliberately refuses to echo `err.message` because an arbitrary
 * message can carry SQL fragments, absolute paths or spawn arguments. So the
 * publish button reported "Internal server error" while the reason sat in the
 * server log:
 *
 *     Package "three" is imported by a runtime script but is not declared in
 *     dependencies (static import in gallery.html-inline-script-5.js)
 *
 * Two people hit this on two different sites and neither could have guessed.
 *
 * The fix is not to loosen the generic catch — that guard is right. It is to
 * carry the diagnostics as DATA so the handler can build a response from
 * fields it knows are author-facing, which is exactly what the generic catch's
 * own comment says inner handlers should do.
 */

import type { SiteRuntimeDiagnostic } from '@core/site-runtime'

export class PublishRuntimeBuildError extends Error {
  readonly diagnostics: readonly SiteRuntimeDiagnostic[]
  /** Slug of the page whose scripts failed — the first place to look. */
  readonly pageSlug: string

  constructor(pageSlug: string, diagnostics: readonly SiteRuntimeDiagnostic[]) {
    super(`runtime build failed for "${pageSlug}": ${diagnostics.map((d) => d.message).join('; ')}`)
    this.name = 'PublishRuntimeBuildError'
    this.pageSlug = pageSlug
    this.diagnostics = diagnostics
  }
}

/**
 * One sentence an operator can act on, built only from diagnostic fields.
 *
 * Never interpolates a raw thrown message, so nothing outside the structured
 * diagnostic shape can reach the client.
 */
export function publishBuildErrorMessage(err: PublishRuntimeBuildError): string {
  const reasons = err.diagnostics.map((d) => d.message)
  const head = `Publish stopped: the scripts on page "${err.pageSlug}" could not be built.`
  return reasons.length > 0 ? `${head} ${reasons.join(' ')}` : head
}
