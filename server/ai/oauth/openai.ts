/**
 * OpenAI ChatGPT/Codex OAuth helpers.
 *
 * This mirrors the public flow used by opencode's OpenAI Codex auth plugin:
 * device authorization via auth.openai.com, token exchange with PKCE, then
 * Responses requests against ChatGPT's Codex endpoint using the OAuth access
 * token instead of an API key.
 */

import { Type, parseValue, type Static } from '@core/utils/typeboxHelpers'
import type { AiProviderModel } from '../drivers/types'

export const OPENAI_OAUTH_ISSUER = 'https://auth.openai.com'
export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_OAUTH_DEVICE_URL = `${OPENAI_OAUTH_ISSUER}/codex/device`
export const OPENAI_OAUTH_CODEX_RESPONSES_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/responses'

const TOKEN_REFRESH_SAFETY_MARGIN_MS = 3_000
const DEVICE_POLLING_SAFETY_MARGIN_MS = 3_000
const USER_AGENT = 'instatic/0.0.7'

export const OPENAI_OAUTH_MODELS: AiProviderModel[] = [
  {
    id: 'gpt-5.5',
    label: 'GPT 5.5',
    tier: 'smartest',
    contextWindow: 400_000,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    catalogueSource: 'live',
    capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
  },
  {
    id: 'gpt-5.4',
    label: 'GPT 5.4',
    tier: 'smart',
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    catalogueSource: 'live',
    capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT 5.4 Mini',
    tier: 'fast',
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    catalogueSource: 'live',
    capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'GPT 5.3 Codex Spark',
    tier: 'fast',
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    catalogueSource: 'live',
    capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
  },
]

const OpenAiDeviceAuthorizationSchema = Type.Object(
  {
    device_auth_id: Type.String(),
    user_code: Type.String(),
    interval: Type.Union([Type.String(), Type.Number()]),
  },
  { additionalProperties: true },
)

const OpenAiDeviceTokenSchema = Type.Object(
  {
    authorization_code: Type.String(),
    code_verifier: Type.String(),
  },
  { additionalProperties: true },
)

const OpenAiTokenResponseSchema = Type.Object(
  {
    access_token: Type.String(),
    refresh_token: Type.Optional(Type.String()),
    expires_in: Type.Optional(Type.Number()),
    id_token: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
)

const OpenAiOAuthSecretSchema = Type.Object({
  refresh: Type.String(),
  access: Type.String(),
  expires: Type.Number(),
  accountId: Type.Optional(Type.String()),
})

type OpenAiDeviceAuthorization = Static<typeof OpenAiDeviceAuthorizationSchema>
type OpenAiDeviceToken = Static<typeof OpenAiDeviceTokenSchema>
type OpenAiTokenResponse = Static<typeof OpenAiTokenResponseSchema>
export type OpenAiOAuthSecret = Static<typeof OpenAiOAuthSecretSchema>

export interface OpenAiDeviceAuthorizationResult {
  deviceAuthId: string
  userCode: string
  intervalMs: number
  verificationUrl: string
}

export interface OpenAiDevicePending {
  deviceAuthId: string
  userCode: string
}

export async function requestOpenAiDeviceAuthorization(): Promise<OpenAiDeviceAuthorizationResult> {
  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
  })
  if (!response.ok) {
    throw new Error(`OpenAI device authorization failed: ${response.status} ${response.statusText}`)
  }

  let body: OpenAiDeviceAuthorization
  try {
    body = parseValue(OpenAiDeviceAuthorizationSchema, await response.json())
  } catch {
    throw new Error('OpenAI device authorization response was invalid.')
  }
  return {
    deviceAuthId: body.device_auth_id,
    userCode: body.user_code,
    intervalMs: intervalMs(body) + DEVICE_POLLING_SAFETY_MARGIN_MS,
    verificationUrl: OPENAI_OAUTH_DEVICE_URL,
  }
}

export async function pollOpenAiDeviceToken(
  pending: OpenAiDevicePending,
): Promise<{ status: 'pending' } | { status: 'success'; secret: OpenAiOAuthSecret }> {
  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      device_auth_id: pending.deviceAuthId,
      user_code: pending.userCode,
    }),
  })

  if (response.status === 403 || response.status === 404) {
    return { status: 'pending' }
  }
  if (!response.ok) {
    throw new Error(`OpenAI device token polling failed: ${response.status} ${response.statusText}`)
  }

  let deviceToken: OpenAiDeviceToken
  try {
    deviceToken = parseValue(OpenAiDeviceTokenSchema, await response.json())
  } catch {
    throw new Error('OpenAI device token response was invalid.')
  }
  const tokens = await exchangeDeviceCodeForTokens(deviceToken)
  return { status: 'success', secret: tokenResponseToSecret(tokens) }
}

export function serializeOpenAiOAuthSecret(secret: OpenAiOAuthSecret): string {
  return JSON.stringify(secret)
}

export function parseOpenAiOAuthSecret(raw: string): OpenAiOAuthSecret {
  return parseValue(OpenAiOAuthSecretSchema, JSON.parse(raw))
}

export function openAiOAuthNeedsRefresh(secret: OpenAiOAuthSecret): boolean {
  return secret.expires <= Date.now() + TOKEN_REFRESH_SAFETY_MARGIN_MS
}

export async function refreshOpenAiOAuthSecret(secret: OpenAiOAuthSecret): Promise<OpenAiOAuthSecret> {
  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: secret.refresh,
      client_id: OPENAI_OAUTH_CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`OpenAI OAuth token refresh failed: ${response.status} ${response.statusText}`)
  }
  let tokens: OpenAiTokenResponse
  try {
    tokens = parseValue(OpenAiTokenResponseSchema, await response.json())
  } catch {
    throw new Error('OpenAI OAuth refresh response was invalid.')
  }
  return tokenResponseToSecret(tokens, secret)
}

function intervalMs(body: OpenAiDeviceAuthorization): number {
  const seconds = typeof body.interval === 'number' ? body.interval : Number.parseInt(body.interval, 10)
  return Math.max(Number.isFinite(seconds) ? seconds : 5, 1) * 1_000
}

async function exchangeDeviceCodeForTokens(deviceToken: OpenAiDeviceToken): Promise<OpenAiTokenResponse> {
  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: deviceToken.authorization_code,
      redirect_uri: `${OPENAI_OAUTH_ISSUER}/deviceauth/callback`,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: deviceToken.code_verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`OpenAI OAuth token exchange failed: ${response.status} ${response.statusText}`)
  }
  try {
    return parseValue(OpenAiTokenResponseSchema, await response.json())
  } catch {
    throw new Error('OpenAI OAuth token exchange response was invalid.')
  }
}

function tokenResponseToSecret(
  tokens: OpenAiTokenResponse,
  previous?: OpenAiOAuthSecret,
): OpenAiOAuthSecret {
  const accountId = extractAccountId(tokens) ?? previous?.accountId
  const refresh = tokens.refresh_token ?? previous?.refresh
  if (!refresh) {
    throw new Error('OpenAI OAuth response did not include a refresh token.')
  }
  return {
    refresh,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1_000,
    ...(accountId ? { accountId } : {}),
  }
}

interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id?: string }>
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
  }
}

function extractAccountId(tokens: OpenAiTokenResponse): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue
    const claims = parseJwtClaims(token)
    const accountId = claims && (
      claims.chatgpt_account_id ||
      claims['https://api.openai.com/auth']?.chatgpt_account_id ||
      claims.organizations?.[0]?.id
    )
    if (accountId) return accountId
  }
  return undefined
}

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')
    return JSON.parse(atob(padded)) as IdTokenClaims
  } catch {
    return undefined
  }
}
