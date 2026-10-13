import { VISITOR_PREFERENCES_RUNTIME_JS } from '@core/visitor-preferences'

/** Fixed publisher engine bytes contain no site settings or user data. */
export function serveVisitorPreferencesRuntime(): Response {
  return new Response(VISITOR_PREFERENCES_RUNTIME_JS, { headers: {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'public, no-cache',
    'x-content-type-options': 'nosniff',
  } })
}
