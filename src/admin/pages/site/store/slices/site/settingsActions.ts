/**
 * Site-level settings mutation: updateSiteSettings.
 *
 * Framework-related settings (colors, typography, spacing, preferences) live
 * in their own files under `./framework/`.
 */

import type { SiteSlice, SiteSliceHelpers } from './types'
import type { SiteSettings } from '@core/page-tree'

type SettingsActions = Pick<SiteSlice, 'updateSiteSettings'>

export function createSettingsActions({
  mutateSite,
}: SiteSliceHelpers): SettingsActions {
  return {
    updateSiteSettings: (patch) => {
      mutateSite((p) => {
        const changed = Object.entries(patch).some(
          ([key, value]) => !Object.is(p.settings[key as keyof SiteSettings], value),
        )
        if (!changed) return false
        Object.assign(p.settings, patch)
        return true
      })
    },
  }
}
