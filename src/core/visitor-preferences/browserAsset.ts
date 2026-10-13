import { installVisitorPreferences } from './runtime'
import { resolveVisitorPreferences } from './resolve'
import { visitorPreferencesValidatorCode } from './validation'

export const VISITOR_PREFERENCES_RUNTIME_PATH = '/_instatic/visitor-preferences.js'
export const VISITOR_PREFERENCES_CONFIG_ATTRIBUTE = 'data-instatic-visitor-preferences'

const validators = Object.entries(visitorPreferencesValidatorCode)
  .map(([name, code]) => name + ': (function () { ' + code + ' })()').join(',\n')

/** Static schema-generated functions; the browser never evaluates code strings. */
export const VISITOR_PREFERENCES_RUNTIME_JS = [
  '(() => {',
  'const validators = { ' + validators + ' };',
  "const raw = document.documentElement.getAttribute('" + VISITOR_PREFERENCES_CONFIG_ATTRIBUTE + "');",
  "if (raw === null) throw new Error('Missing native visitor preference configuration');",
  'const config = JSON.parse(raw);',
  'return (' + installVisitorPreferences.toString() + ')(document, config, validators, ' + resolveVisitorPreferences.toString() + ');',
  '})();',
].join('\n')
