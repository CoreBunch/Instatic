import type { SiteSettings } from '@core/page-tree'
import { SiteVisitorPreferencesSchema, VisitorPreferencesValidationError } from '@core/visitor-preferences-schema'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { VISITOR_PREFERENCES_CONFIG_ATTRIBUTE, VISITOR_PREFERENCES_RUNTIME_PATH } from '@core/visitor-preferences'
import { escapeHtml } from './utils'

/** Preferences are authored settings; absence means no document capability. */
export function buildVisitorPreferencesHead(settings: SiteSettings, storage: 'persistent' | 'memory') {
  const defaults = settings.visitorPreferences
  if (defaults === undefined) return { htmlAttributes: '', script: '' }
  if (!compiledCheck(SiteVisitorPreferencesSchema, defaults)) throw new VisitorPreferencesValidationError('settings.visitorPreferences')
  return {
    htmlAttributes: ' ' + VISITOR_PREFERENCES_CONFIG_ATTRIBUTE + '="' + escapeHtml(JSON.stringify({ defaults, storage })) + '"',
    // This is deliberately synchronous: the document palette is selected
    // before any authored stylesheet or body content can paint.
    script: '<script src="' + VISITOR_PREFERENCES_RUNTIME_PATH + '"></script>',
  }
}
