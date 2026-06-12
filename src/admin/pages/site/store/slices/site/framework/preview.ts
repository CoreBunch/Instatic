/**
 * Preview a destructive framework change without committing it.
 *
 * Clones the current site, applies the caller's mutation to the clone, runs
 * every framework reconciler, then diffs to surface the framework classes
 * that would disappear and every place those classes are still in use.
 *
 * Returns `null` when the change removes nothing in use — in that case the
 * caller is free to commit silently.
 */

import { previewFrameworkClassRemovals } from '@core/framework'
import { reconcileFrameworkClasses } from './reconcile'
import type { SiteSlice, SiteSliceHelpers } from '@site/store/slices/site/types'

type FrameworkPreviewActions = Pick<SiteSlice, 'previewFrameworkChange'>

export function createFrameworkPreviewActions({
  get,
}: SiteSliceHelpers): FrameworkPreviewActions {
  return {
    previewFrameworkChange: (applyChange) => {
      const { site } = get()
      if (!site) return null
      const draft = structuredClone(site)
      applyChange(draft)
      reconcileFrameworkClasses(draft)
      return previewFrameworkClassRemovals(site, draft)
    },
  }
}
