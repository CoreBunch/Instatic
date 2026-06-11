/**
 * Framework preferences — single store action.
 */

import { DEFAULT_FRAMEWORK_PREFERENCES } from '@core/framework'
import type { SiteSlice, SiteSliceHelpers } from '@site/store/slices/site/types'

type FrameworkPreferencesActions = Pick<SiteSlice, 'updateFrameworkPreferences'>

export function createFrameworkPreferencesActions({
  mutateSite,
}: SiteSliceHelpers): FrameworkPreferencesActions {
  return {
    updateFrameworkPreferences: (patch) => {
      mutateSite((site) => {
        const entries = Object.entries(patch)
        if (entries.length === 0) return false
        const current = site.settings.framework?.preferences ?? DEFAULT_FRAMEWORK_PREFERENCES
        const changed = entries.some(
          ([key, value]) => !Object.is(current[key as keyof typeof current], value),
        )
        if (!changed) return false
        if (!site.settings.framework) {
          site.settings.framework = { colors: { tokens: [] } }
        }
        site.settings.framework.preferences = { ...current, ...patch }
        return true
      })
    },
  }
}
