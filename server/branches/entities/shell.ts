/**
 * The site shell is one row that the site adapter and the file adapter both
 * write into; a merged shell is rebuilt from stored JSON and must be valid
 * as a whole before it becomes the draft, exactly like the relay's
 * projection.
 */
import { SiteValidationError, validateSite } from '@core/persistence/validate'
import { MergeApplyError } from './adapter'

/** A merged shell that fails validation is a refused change, not a crash. */
export function validateMergedShell(key: string, candidate: unknown): ReturnType<typeof validateSite> {
  try {
    return validateSite(candidate)
  } catch (err) {
    if (err instanceof SiteValidationError) throw new MergeApplyError(key, `The merged site is invalid: ${err.message}`)
    throw err
  }
}
