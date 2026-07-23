/**
 * Thin client-side API wrappers for the AI runtime HTTP surface.
 *
 * Every function goes through the canonical `apiRequest` (`@core/http`),
 * which POSTs/GETs the wire shapes defined in `server/ai/handlers/*`,
 * validates the response with TypeBox, and throws an `ApiError` (carrying
 * the server status + message) on failure — pages render these via
 * `role="alert"` panels.
 *
 * Constraint #272 — every untyped boundary (HTTP response) is validated
 * against a TypeBox schema before reaching React state.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { apiRequest, ApiError } from '@core/http'
import {
  AiContentViewBlockSchema,
  McpConnectionOverviewSchema,
  CreateMcpAccessTokenResultSchema,
  McpOAuthAuthorizationViewSchema,
  DecideMcpOAuthAuthorizationResultSchema,
  type McpConnectionOverview,
  type CreateMcpAccessTokenBody,
  type CreateMcpAccessTokenResult,
  type McpOAuthAuthorizationView,
  type DecideMcpOAuthAuthorizationBody,
} from '@core/ai'

// ---------------------------------------------------------------------------
// Wire schemas — match server projections in:
//   server/ai/credentials/types.ts → CredentialView
//   server/ai/conversations/types.ts → ConversationView
//   server/ai/defaults/store.ts → DefaultRecord
// ---------------------------------------------------------------------------

const ProviderId = Type.Union([
  Type.Literal('anthropic'),
  Type.Literal('openai'),
  Type.Literal('ollama'),
  Type.Literal('openrouter'),
  Type.Literal('openai-compatible'),
])

const AuthMode = Type.Union([
  Type.Literal('apiKey'),
  Type.Literal('baseUrl'),
])

const ToolScope = Type.Union([
  Type.Literal('site'),
  Type.Literal('content'),
  Type.Literal('data'),
  Type.Literal('plugin'),
])

const CredentialViewSchema = Type.Object({
  id: Type.String(),
  providerId: ProviderId,
  authMode: AuthMode,
  displayLabel: Type.String(),
  baseUrl: Type.Union([Type.String(), Type.Null()]),
  keyFingerprintCurrent: Type.Boolean(),
  createdAt: Type.String(),
  lastUsedAt: Type.Union([Type.String(), Type.Null()]),
})

export type CredentialView = Static<typeof CredentialViewSchema>

const CredentialListResponseSchema = Type.Object({
  credentials: Type.Array(CredentialViewSchema),
})

const CredentialItemResponseSchema = Type.Object({
  credential: CredentialViewSchema,
})

const TestResponseSchema = Type.Object({
  ok: Type.Boolean(),
  modelCount: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
})

const ModelSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  capabilities: Type.Object({
    toolCalling: Type.Boolean(),
    visionInput: Type.Boolean(),
    toolResultImages: Type.Boolean(),
    promptCache: Type.Boolean(),
    streaming: Type.Boolean(),
  }),
  tier: Type.Optional(Type.String()),
  /** Per-million-token list prices, shown inline in the picker. */
  pricing: Type.Optional(Type.Object({
    inputPerMTok: Type.Number(),
    outputPerMTok: Type.Number(),
  })),
  /** Max context window (total tokens) — feeds the composer context meter. */
  contextWindow: Type.Optional(Type.Number()),
  /** Whether the server returned a live provider model or a local fallback hint. */
  catalogueSource: Type.Optional(Type.Union([Type.Literal('live'), Type.Literal('fallback')])),
})
export type AiModel = Static<typeof ModelSchema>

const ModelListResponseSchema = Type.Object({
  models: Type.Array(ModelSchema),
})

const DefaultEntrySchema = Type.Object({
  credentialId: Type.String(),
  modelId: Type.String(),
})
const DefaultsResponseSchema = Type.Object({
  defaults: Type.Record(Type.String(), DefaultEntrySchema),
})
export type AiDefaults = Static<typeof DefaultsResponseSchema>['defaults']

const ConversationViewSchema = Type.Object({
  id: Type.String(),
  scope: ToolScope,
  title: Type.String(),
  credentialId: Type.Union([Type.String(), Type.Null()]),
  modelId: Type.String(),
  promptTokensTotal: Type.Number(),
  completionTokensTotal: Type.Number(),
  costUsdTotal: Type.Number(),
  cacheReadTokensTotal: Type.Number(),
  cacheCreationTokensTotal: Type.Number(),
  /** Current-context snapshot for the composer meter (latest turn). */
  contextTokens: Type.Number(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})
export type ConversationView = Static<typeof ConversationViewSchema>

const ConversationListResponseSchema = Type.Object({
  conversations: Type.Array(ConversationViewSchema),
})

const ConversationItemResponseSchema = Type.Object({
  conversation: ConversationViewSchema,
})

const MessageViewSchema = Type.Object({
  id: Type.String(),
  position: Type.Number(),
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('tool')]),
  // The conversation-view vocabulary is owned by `@core/ai`: non-image blocks
  // match persistence, while image bytes are projected to authenticated URLs.
  content: Type.Array(AiContentViewBlockSchema),
  toolCallId: Type.Union([Type.String(), Type.Null()]),
  toolName: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
})

export const ConversationDetailViewSchema = Type.Composite([
  ConversationViewSchema,
  Type.Object({
    messages: Type.Array(MessageViewSchema),
  }),
])
export type ConversationDetail = Static<typeof ConversationDetailViewSchema>

const ConversationDetailResponseSchema = Type.Object({
  conversation: ConversationDetailViewSchema,
})

// ---------------------------------------------------------------------------
// Endpoints — credentials
//
// Every call goes through the canonical `apiRequest` (`@core/http`): it sets
// credentials, validates the success body with TypeBox, and throws a single
// `ApiError` (carrying the HTTP status) on failure. UI branches on
// `err instanceof ApiError && err.status === …`.
// ---------------------------------------------------------------------------

export async function listCredentials(signal?: AbortSignal): Promise<CredentialView[]> {
  const body = await apiRequest('/admin/api/ai/credentials', { schema: CredentialListResponseSchema, signal })
  return body.credentials
}

export type CreateCredentialBody =
  | {
      providerId: 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'openai-compatible'
      authMode: 'apiKey'
      displayLabel: string
      apiKey: string
    }
  | {
      providerId: 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'openai-compatible'
      authMode: 'baseUrl'
      displayLabel: string
      baseUrl: string
      apiKey?: string
    }

export async function createCredential(body: CreateCredentialBody): Promise<CredentialView> {
  const parsed = await apiRequest('/admin/api/ai/credentials', {
    method: 'POST',
    body,
    schema: CredentialItemResponseSchema,
  })
  return parsed.credential
}

export async function deleteCredential(id: string): Promise<void> {
  await apiRequest(`/admin/api/ai/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' })
  clearModelListCache(id)
}

export interface TestResult {
  ok: boolean
  modelCount?: number
  error?: string
}

export async function testCredential(id: string): Promise<TestResult> {
  // The test endpoint returns 200 even on auth failure (the body carries
  // `{ ok: false, error }`) so callers can render the error inline. A 404
  // means the credential row is gone — surface a friendly message.
  try {
    return await apiRequest(`/admin/api/ai/credentials/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      schema: TestResponseSchema,
    })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new ApiError('Credential not found.', 404)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Endpoints — models
// ---------------------------------------------------------------------------

const MODEL_LIST_TIMEOUT_MS = 10_000
const MODEL_LIST_CACHE_TTL_MS = 5 * 60_000
const modelListRequests = new Map<string, Promise<AiModel[]>>()
const modelListCache = new Map<string, { expiresAt: number; models: AiModel[] }>()

/** Invalidate model catalogues after a credential mutation (or between tests). */
export function clearModelListCache(credentialId?: string): void {
  if (!credentialId) {
    modelListCache.clear()
    return
  }
  for (const key of modelListCache.keys()) {
    if (key.endsWith(`\0${credentialId}`)) modelListCache.delete(key)
  }
}

export async function listModels(
  providerId: 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'openai-compatible',
  credentialId?: string,
): Promise<AiModel[]> {
  const key = `${providerId}\0${credentialId ?? ''}`
  const cached = modelListCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.models
  if (cached) modelListCache.delete(key)
  const pending = modelListRequests.get(key)
  if (pending) return pending

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS)
  const request = apiRequest(`/admin/api/ai/providers/${providerId}/models`, {
    query: { credentialId },
    schema: ModelListResponseSchema,
    signal: controller.signal,
  }).then((body) => {
    modelListCache.set(key, {
      expiresAt: Date.now() + MODEL_LIST_CACHE_TTL_MS,
      models: body.models,
    })
    return body.models
  })
  modelListRequests.set(key, request)
  try {
    return await request
  } finally {
    clearTimeout(timeoutId)
    if (modelListRequests.get(key) === request) modelListRequests.delete(key)
  }
}

// ---------------------------------------------------------------------------
// Endpoints — defaults
// ---------------------------------------------------------------------------

export async function listDefaults(): Promise<AiDefaults> {
  const body = await apiRequest('/admin/api/ai/defaults', { schema: DefaultsResponseSchema })
  return body.defaults
}

export async function setDefault(
  scope: 'site' | 'content' | 'data' | 'plugin',
  body: { credentialId: string; modelId: string },
): Promise<void> {
  await apiRequest(`/admin/api/ai/defaults/${scope}`, { method: 'PUT', body })
}

export async function clearDefault(scope: 'site' | 'content' | 'data' | 'plugin'): Promise<void> {
  await apiRequest(`/admin/api/ai/defaults/${scope}`, { method: 'DELETE' })
}

// ---------------------------------------------------------------------------
// Endpoints — conversations
// ---------------------------------------------------------------------------

export async function listConversations(scope: 'site' | 'content' | 'data' | 'plugin'): Promise<ConversationView[]> {
  const body = await apiRequest('/admin/api/ai/conversations', {
    query: { scope },
    schema: ConversationListResponseSchema,
  })
  return body.conversations
}

export async function getConversation(
  id: string,
  signal?: AbortSignal,
): Promise<ConversationDetail> {
  const body = await apiRequest(`/admin/api/ai/conversations/${encodeURIComponent(id)}`, {
    schema: ConversationDetailResponseSchema,
    signal,
  })
  return body.conversation
}

export async function deleteConversation(id: string): Promise<void> {
  await apiRequest(`/admin/api/ai/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function updateConversationProvider(
  id: string,
  credentialId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<ConversationView> {
  const body = await apiRequest(`/admin/api/ai/conversations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { credentialId, modelId },
    schema: ConversationItemResponseSchema,
    signal,
  })
  return body.conversation
}

// ---------------------------------------------------------------------------
// Endpoints — audit
// ---------------------------------------------------------------------------

const UsageRowSchema = Type.Object({
  promptTokens: Type.Number(),
  completionTokens: Type.Number(),
  costUsd: Type.Number(),
  chatCount: Type.Number(),
  cacheReadTokens: Type.Number(),
  cacheCreationTokens: Type.Number(),
})

const UsageByUserRowSchema = Type.Composite([
  UsageRowSchema,
  Type.Object({
    userId: Type.String(),
    userLabel: Type.String(),
  }),
])

const UsageByScopeRowSchema = Type.Composite([
  UsageRowSchema,
  Type.Object({
    scope: ToolScope,
  }),
])

const UsageByDayRowSchema = Type.Composite([
  UsageRowSchema,
  Type.Object({
    day: Type.String(),
  }),
])

const UsageByModelRowSchema = Type.Composite([
  UsageRowSchema,
  Type.Object({
    // Server may report 'unknown' for conversations whose credential was
    // deleted mid-window — keep this loose enough to accept that.
    providerId: Type.String(),
    modelId: Type.String(),
  }),
])

const AuditResponseSchema = Type.Object({
  since: Type.String(),
  totals: UsageRowSchema,
  byUser: Type.Array(UsageByUserRowSchema),
  byScope: Type.Array(UsageByScopeRowSchema),
  byModel: Type.Array(UsageByModelRowSchema),
  byDay: Type.Array(UsageByDayRowSchema),
})

export type AiUsageByUserRow = Static<typeof UsageByUserRowSchema>
export type AiUsageByScopeRow = Static<typeof UsageByScopeRowSchema>
export type AiUsageByDayRow = Static<typeof UsageByDayRowSchema>
export type AiUsageByModelRow = Static<typeof UsageByModelRowSchema>
export type AiAuditResponse = Static<typeof AuditResponseSchema>

/**
 * Fetch the AI usage rollups. `since` is an ISO date the server interprets
 * as "include any message at or after this instant". Omit to default to the
 * server's 30-day window. `timeZone` is an IANA zone the server uses to bucket
 * the daily rollup into the viewer's calendar day (falls back to UTC server-side
 * when omitted or invalid).
 */
export async function listAiAudit(
  since?: string,
  timeZone?: string,
): Promise<AiAuditResponse> {
  return apiRequest('/admin/api/ai/audit', {
    query: { since, tz: timeZone },
    schema: AuditResponseSchema,
  })
}

// ---------------------------------------------------------------------------
// MCP connections + OAuth consent. Wire shapes are the shared TypeBox schemas
// from `@core/ai`; the plaintext personal access token is returned only by
// `createMcpAccessToken` and is never persisted client-side.
// ---------------------------------------------------------------------------

const MCP_CONNECTIONS_BASE = '/admin/api/ai/mcp/connections'
const MCP_ACCESS_TOKENS_PATH = '/admin/api/ai/mcp/access-tokens'
const MCP_OAUTH_AUTHORIZATION_PATH = '/admin/api/ai/mcp/oauth/authorization'

export async function getMcpConnectionOverview(signal?: AbortSignal): Promise<McpConnectionOverview> {
  return apiRequest(MCP_CONNECTIONS_BASE, { schema: McpConnectionOverviewSchema, signal })
}

export async function createMcpAccessToken(
  body: CreateMcpAccessTokenBody,
): Promise<CreateMcpAccessTokenResult> {
  return apiRequest(MCP_ACCESS_TOKENS_PATH, {
    method: 'POST',
    body,
    schema: CreateMcpAccessTokenResultSchema,
  })
}

export async function revokeMcpConnection(id: string): Promise<void> {
  await apiRequest(`${MCP_CONNECTIONS_BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function getMcpOAuthAuthorization(
  search: string,
): Promise<McpOAuthAuthorizationView> {
  return apiRequest(`${MCP_OAUTH_AUTHORIZATION_PATH}${search}`, {
    schema: McpOAuthAuthorizationViewSchema,
  })
}

export async function decideMcpOAuthAuthorization(
  body: DecideMcpOAuthAuthorizationBody,
): Promise<string> {
  const result = await apiRequest(MCP_OAUTH_AUTHORIZATION_PATH, {
    method: 'POST',
    body,
    schema: DecideMcpOAuthAuthorizationResultSchema,
  })
  return result.redirectUrl
}
