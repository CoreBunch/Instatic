/**
 * Shared vocabulary of the persistence-validation modules (`validate.ts`,
 * `validateLayouts.ts`): the error type plus the small helpers both files
 * need. `SiteValidationError` is re-exported from `validate.ts`, which stays
 * the canonical import path for consumers.
 */

import { isRichtextPropKey, sanitizeRichtext } from '@core/sanitize'

export class SiteValidationError extends Error {
  readonly path: string
  constructor(message: string, path: string) {
    super(`[persistence/validate] ${path}: ${message}`)
    this.name = 'SiteValidationError'
    this.path = path
  }
}

export function siteValidationErrorFromTreeInvariant(err: unknown, fallbackPath: string): SiteValidationError {
  const message = err instanceof Error ? err.message : 'invalid node tree'
  const colonIndex = message.indexOf(': ')
  const path = colonIndex > 0 ? message.slice(0, colonIndex) : fallbackPath
  return new SiteValidationError(message, path)
}

/**
 * Walk a node's props and sanitize richtext-keyed values in-place.
 * Operates on a single flat node — no childNodes recursion (trees are flat).
 */
export function sanitizeNodeProps(node: unknown): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  const n = node as { props?: Record<string, unknown> }
  if (n.props && typeof n.props === 'object') {
    for (const [key, val] of Object.entries(n.props)) {
      if (isRichtextPropKey(key) && typeof val === 'string') {
        n.props[key] = sanitizeRichtext(val)
      }
    }
  }
}
