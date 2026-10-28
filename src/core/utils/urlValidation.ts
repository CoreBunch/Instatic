/**
 * URL Validation Utilities
 *
 * Centralised allowlist predicates for editor property controls.
 * Both functions follow the same contract: empty string → true (no value is
 * valid for optional fields), non-empty string → validate the scheme.
 *
 * These are the **input-boundary** gates, applied at user-input / site-load
 * time. `isSafeUrl()` in `@core/html-sanitize` is the **enforcement** gate,
 * applied at HTML export time. Both read the scheme through the same
 * `urlScheme()` extractor so the two can never disagree about what a value's
 * scheme is — they differ only in which schemes they accept.
 *
 * Allowlists:
 *   isValidUrl()       — https, http, mailto
 *   isValidImageUrl()  — https, http, data:image/* (inline base64 images)
 */

import { urlScheme } from '@core/html-sanitize'

/**
 * Well-formedness check, kept separate from the scheme decision.
 *
 * `urlScheme()` reads only the leading `scheme:` token — it says nothing about
 * whether the rest of the value parses. These predicates are input-boundary
 * gates whose job includes catching typos (`https://exa mple.com`, `http://`),
 * so they need both halves: the shared scheme extractor for the security
 * decision, and a real parse for well-formedness.
 *
 * Unlike `@core/html-sanitize`, this module is admin-only (React property
 * controls) and never bundled into a QuickJS plugin pack, so `new URL()` is
 * available here.
 */
function parses(v: string): boolean {
  try {
    new URL(v)
    return true
  } catch {
    return false
  }
}

/**
 * Returns true if `v` is a safe general-purpose URL for storing in site
 * props (e.g. a link href, a button href).
 *
 * Allows:  https:, http:, mailto:
 * Rejects: javascript:, data:, ftp:, blob:, custom schemes, schemeless values,
 *          and malformed absolute URLs (`http://`, `https://exa mple.com`)
 */
export function isValidUrl(v: string): boolean {
  if (!v) return true
  const scheme = urlScheme(v)
  if (scheme !== 'https:' && scheme !== 'http:' && scheme !== 'mailto:') return false
  return parses(v)
}

/**
 * Returns true if `v` is a safe URL to use as an `<img src>`.
 *
 * Allows:  https:, http:, data:image/* (e.g. data:image/png;base64,…)
 * Rejects: javascript:, data:text/html, data:application/*, blob:, ftp:,
 *          mailto:, custom schemes, schemeless values, and malformed
 *          absolute URLs
 *
 * Note: `data:image/*` is allowed because base64-encoded inline images are a
 * legitimate use case in the editor (e.g. pasted screenshots, small icons).
 * All other `data:` subtypes are rejected to prevent unexpected content from
 * rendering in the editor preview. The publisher's `isSafeUrl()` rejects every
 * `data:` URL, so such a value renders in the canvas but not on the published
 * page — a known divergence, tracked separately.
 */
export function isValidImageUrl(v: string): boolean {
  if (!v) return true
  const scheme = urlScheme(v)
  if (scheme === 'https:' || scheme === 'http:') return parses(v)
  if (scheme === 'data:') return v.trimStart().toLowerCase().startsWith('data:image/')
  return false
}

/** Strip trailing slashes so a base URL can be joined with `/<path>` without doubling. */
export function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}
