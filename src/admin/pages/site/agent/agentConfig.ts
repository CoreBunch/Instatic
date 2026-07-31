/**
 * Site-editor agent network configuration.
 *
 * As of Phase 3 the site editor talks to the new AI runtime at
 * `/admin/api/ai/chat/site` (provider-agnostic, multi-driver). The browser
 * tool results are posted through the shared admin AI bridge API.
 *
 * Endpoints live under `/admin/api/` so the session cookie scoped to
 * `Path=/admin` is sent by the browser. Outside `/admin/`, the cookie
 * wouldn't be carried and the `requireCapability('ai.chat' /
 * 'ai.tools.write')` gates would 401 every request.
 */

/** Per-scope defaults endpoint — read at panel open to discover the active
    credential + model for new conversations. */
export const AI_DEFAULTS_PATH = '/admin/api/ai/defaults' as const

/** Conversations endpoint root — POST to create, GET list with `?scope=site`. */
export const AI_CONVERSATIONS_PATH = '/admin/api/ai/conversations' as const
