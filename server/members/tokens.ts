/**
 * Single-use, expiring tokens for links sent by email (`member_tokens`).
 *
 * Like session tokens they are 32 random bytes and only their SHA-256 is
 * stored. Issuing a token of a kind withdraws the member's earlier unused
 * tokens of that kind, so only the newest link works. Consuming is one
 * conditional UPDATE: of two requests racing on the same token, exactly one
 * finds `used_at is null`.
 */
import type { DbClient } from '../db/client'
import { nowIso } from '@core/utils/isoDate'
import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'
import { MemberProfileSchema } from '@core/members'
import { createSessionToken, hashSessionToken } from '../auth/tokens'

export type MemberTokenKind = 'verify' | 'reset' | 'magic' | 'invite' | 'email_change'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/** How long each kind of link stays valid. */
export const TOKEN_LIFETIME_MS: Record<MemberTokenKind, number> = {
  verify: 24 * HOUR,
  reset: HOUR,
  magic: 15 * MINUTE,
  invite: 7 * 24 * HOUR,
  email_change: HOUR,
}

/**
 * What a token carries besides who it is for.
 *  - `email`: the new address, for `email_change`.
 *  - `passwordHash`, `nonceHash`, `profile`: a pending sign-up,
 *    for `verify` (see `signUp` in `service.ts`).
 */
const TokenPayloadSchema = Type.Object({
  email: Type.Optional(Type.String()),
  passwordHash: Type.Optional(Type.String()),
  nonceHash: Type.Optional(Type.String()),
  profile: Type.Optional(MemberProfileSchema),
})
type TokenPayload = Static<typeof TokenPayloadSchema>

interface IssuedToken {
  token: string
  expiresAt: string
}

export async function issueMemberToken(
  db: DbClient,
  memberId: string,
  kind: MemberTokenKind,
  payload: TokenPayload = {},
  now = Date.now(),
): Promise<IssuedToken> {
  const token = createSessionToken()
  const idHash = await hashSessionToken(token)
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + TOKEN_LIFETIME_MS[kind]).toISOString()
  await db.transaction(async (tx) => {
    await tx`
      update member_tokens set used_at = ${createdAt}
       where member_id = ${memberId} and kind = ${kind} and used_at is null
    `
    await tx`
      insert into member_tokens (id_hash, member_id, kind, payload_json, created_at, expires_at)
      values (${idHash}, ${memberId}, ${kind}, ${payload}, ${createdAt}, ${expiresAt})
    `
  })
  return { token, expiresAt }
}

export interface ConsumedToken {
  memberId: string
  payload: TokenPayload
}

/**
 * Use up a token. Returns who it belonged to, or null when it is unknown, of
 * another kind, expired or already used. A null never says which.
 */
export async function consumeMemberToken(
  db: DbClient,
  token: string,
  kind: MemberTokenKind,
  now = Date.now(),
): Promise<ConsumedToken | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null
  const idHash = await hashSessionToken(token)
  const current = new Date(now).toISOString()
  const { rows } = await db<{ member_id: string; payload_json: unknown }>`
    update member_tokens set used_at = ${current}
     where id_hash = ${idHash} and kind = ${kind} and used_at is null and expires_at > ${current}
    returning member_id, payload_json
  `
  const row = rows[0]
  if (!row) return null
  const payload = safeParseValue(TokenPayloadSchema, row.payload_json)
  return { memberId: row.member_id, payload: payload.ok ? payload.value : {} }
}

/** Is this token still usable? Read-only: for rendering the page a link opens. */
export async function memberTokenIsLive(
  db: DbClient,
  token: string,
  kind: MemberTokenKind,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return false
  const idHash = await hashSessionToken(token)
  const { rows } = await db<{ id_hash: string }>`
    select id_hash from member_tokens
     where id_hash = ${idHash} and kind = ${kind} and used_at is null and expires_at > ${nowIso()}
  `
  return rows.length > 0
}

/** Withdraw every unused token of a member (password change, deletion). */
export async function withdrawMemberTokens(db: DbClient, memberId: string): Promise<void> {
  await db`
    update member_tokens set used_at = ${nowIso()}
     where member_id = ${memberId} and used_at is null
  `
}
