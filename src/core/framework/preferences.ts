/**
 * Resolve framework preferences with sensible Core Framework defaults.
 *
 * The settings.framework.preferences subtree is optional; when absent we fall
 * back to the same constants Core Framework uses (root_font_size=10, isRem=true,
 * minScreen=320, maxScreen=1400). Pulling this through a single helper keeps
 * the publisher and the canvas aligned with the editor.
 *
 * `raw` is already schema-validated (`FrameworkPreferencesSettingsSchema`), so
 * field-level constraints — finite numbers, `rootFontSize >= 1` to guard the
 * px→rem division — are enforced at that boundary. This helper only layers the
 * defaults for any field the persisted settings omitted; it does not re-validate.
 */

import type { FrameworkPreferencesSettings } from '@core/framework-schema'
import {
  DEFAULT_FRAMEWORK_PREFERENCES,
  type FrameworkPreferences,
} from './scale'

export function resolveFrameworkPreferences(
  raw: FrameworkPreferencesSettings | null | undefined,
): FrameworkPreferences {
  return raw ? { ...DEFAULT_FRAMEWORK_PREFERENCES, ...raw } : { ...DEFAULT_FRAMEWORK_PREFERENCES }
}

export { DEFAULT_FRAMEWORK_PREFERENCES }
