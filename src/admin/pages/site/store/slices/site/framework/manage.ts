/**
 * Core Framework lifecycle store action — the editor side of the Manage
 * Framework dialog.
 *
 * `setFrameworkPreset` mutates `site.settings.framework` inside `mutateSite` and
 * then calls `reconcileFrameworkClasses(draft)`, which regenerates the desired
 * framework class registry, prunes the rest, and strips stale `framework:`
 * classIds off every node. Because it runs through `mutateSite`, it is recorded
 * in the editor's undo history.
 */
import { applyFrameworkPreset } from '@core/framework'
import type { SiteSlice, SiteSliceHelpers } from '../types'
import { reconcileFrameworkClasses } from './reconcile'

type FrameworkManagerActions = Pick<SiteSlice, 'setFrameworkPreset'>

export function createFrameworkManagerActions({
  get,
  mutateSite,
}: SiteSliceHelpers): FrameworkManagerActions {
  return {
    setFrameworkPreset: (target) => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      if (target === 'none' && !site.settings.framework) return
      // Compute from the (frozen) live settings; assign inside the draft.
      const next = applyFrameworkPreset(site.settings.framework, target)
      mutateSite((draftSite) => {
        draftSite.settings.framework = next
        reconcileFrameworkClasses(draftSite)
        return true
      })
    },
  }
}
