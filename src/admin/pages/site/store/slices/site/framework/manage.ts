/**
 * Core Framework lifecycle store actions — the editor side of the Manage
 * Framework dialog.
 *
 * Each action mutates `site.settings.framework` inside `mutateSite` and then
 * calls `reconcileFrameworkClasses(draft)`, which regenerates the desired
 * framework class registry, prunes the rest, and strips stale `framework:`
 * classIds off every node. Because they run through `mutateSite`, all three are
 * recorded in the editor's undo history.
 */
import {
  collectUsedFrameworkClassIds,
  mergeCoreFrameworkSettings,
  pruneUnusedFrameworkTokens,
} from '@core/framework'
import type { SiteSlice, SiteSliceHelpers } from '../types'
import { reconcileFrameworkClasses } from './reconcile'

type FrameworkManagerActions = Pick<
  SiteSlice,
  'importCoreFramework' | 'removeFrameworkCompletely' | 'pruneUnusedFrameworkClasses'
>

export function createFrameworkManagerActions({
  get,
  mutateSite,
}: SiteSliceHelpers): FrameworkManagerActions {
  return {
    importCoreFramework: (mode) => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      // Compute from the (frozen) live settings; assign inside the draft.
      const next = mergeCoreFrameworkSettings(site.settings.framework, {
        includeUtilities: mode === 'full',
      })
      mutateSite((draftSite) => {
        draftSite.settings.framework = next
        reconcileFrameworkClasses(draftSite)
        return true
      })
    },

    removeFrameworkCompletely: () => {
      mutateSite((draftSite) => {
        if (!draftSite.settings.framework) return false
        draftSite.settings.framework = undefined
        reconcileFrameworkClasses(draftSite)
        return true
      })
    },

    pruneUnusedFrameworkClasses: () => {
      const { site } = get()
      if (!site?.settings.framework) return
      const used = collectUsedFrameworkClassIds(site)
      const { next } = pruneUnusedFrameworkTokens(site.settings.framework, used)
      mutateSite((draftSite) => {
        draftSite.settings.framework = next
        reconcileFrameworkClasses(draftSite)
        return true
      })
    },
  }
}
