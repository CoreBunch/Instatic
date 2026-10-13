import type { SiteVisitorPreferences, VisitorPreferenceOverrides } from '@core/visitor-preferences-schema'

/** Pure resolver, also emitted as the owned browser asset's static function. */
export function resolveVisitorPreferences(
  defaults: SiteVisitorPreferences,
  overrides: VisitorPreferenceOverrides,
  operatingSystem: { dark: boolean; reducedMotion: boolean },
) {
  const selected = { ...defaults, ...overrides }
  return {
    selected,
    theme: selected.theme === 'system' ? (operatingSystem.dark ? 'alt' : 'default') : selected.theme,
    reducedMotion: operatingSystem.reducedMotion || selected.motion === 'reduced',
    reducedMedia: selected.media === 'reduced',
  }
}

export type ResolvedVisitorPreferences = ReturnType<typeof resolveVisitorPreferences>
