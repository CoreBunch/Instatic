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
import { mergeCoreFrameworkSettings, setFrameworkUtilities } from '@core/framework'
import type { SiteSlice, SiteSliceHelpers } from '../types'
import { reconcileFrameworkClasses } from './reconcile'

type FrameworkManagerActions = Pick<SiteSlice, 'setFrameworkPreset'>

export function createFrameworkManagerActions({
  get,
  mutateSite,
}: SiteSliceHelpers): FrameworkManagerActions {
  return {
    setFrameworkPreset: (target) => {
      if (target === 'none') {
        mutateSite((draftSite) => {
          if (!draftSite.settings.framework) return false
          draftSite.settings.framework = undefined
          reconcileFrameworkClasses(draftSite)
          return true
        })
        return
      }

      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      // Compute from the (frozen) live settings; assign inside the draft.
      // Merge add-missing first (so 'full' restores the typography/spacing class
      // generators a prior 'variables' round stripped), then flip utilities to
      // match the target so existing tokens switch state, not just new ones.
      const includeUtilities = target === 'full'
      const merged = mergeCoreFrameworkSettings(site.settings.framework, { includeUtilities })
      const next = setFrameworkUtilities(merged, includeUtilities)
      mutateSite((draftSite) => {
        draftSite.settings.framework = next
        reconcileFrameworkClasses(draftSite)
        return true
      })
    },
  }
}
