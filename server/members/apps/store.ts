/**
 * Rows behind sign-in for apps: the apps a site owner registered, the
 * authorization requests waiting for a member's answer, and the grants,
 * codes and tokens that come out of an approval.
 *
 * A token or a code is only ever returned while the member behind its grant
 * is active, so suspending or deleting a member ends app access on the next
 * request without touching these tables.
 */
import { nanoid } from 'nanoid'
import { nowIso } from '@core/utils/isoDate'
import type { DbClient } from '../../db/client'
import type {
  GrantStore,
  OAuthRealm,
  StoredAuthorizationCode,
  StoredRefreshToken,
} from '../../oauth/grants'
import { generateOpaqueToken, hashOpaqueToken } from '../../oauth/secrets'
import { normalizeMemberAppScope } from './protocol'

const REQUEST_TTL_MS = 10 * 60 * 1000
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
/** How long an approval lasts before the member has to sign the app in again. */
const GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000

// ─── Apps ──────────────────────────────────────────────────────────────────

export interface MemberAppRecord {
  id: string
  name: string
  redirectUris: readonly string[]
  scopes: readonly string[]
  createdAt: string
}

interface MemberAppRow {
  id: string
  name: string
  redirect_uris_json: string[]
  scopes_json: string[]
  created_at: string
}

function appFromRow(row: MemberAppRow): MemberAppRecord {
  return {
    id: row.id,
    name: row.name,
    redirectUris: Array.isArray(row.redirect_uris_json) ? row.redirect_uris_json : [],
    scopes: Array.isArray(row.scopes_json) ? row.scopes_json : [],
    createdAt: row.created_at,
  }
}

export async function createMemberApp(
  db: DbClient,
  input: { name: string; redirectUris: readonly string[]; scopes: readonly string[]; createdByUserId: string | null },
): Promise<MemberAppRecord> {
  const id = `imem_app_${nanoid(24)}`
  const { rows } = await db<MemberAppRow>`
    insert into member_apps (id, name, redirect_uris_json, scopes_json, created_by_user_id, created_at)
    values (
      ${id}, ${input.name}, ${JSON.stringify(input.redirectUris)}, ${JSON.stringify(input.scopes)},
      ${input.createdByUserId}, ${nowIso()}
    )
    returning id, name, redirect_uris_json, scopes_json, created_at
  `
  if (!rows[0]) throw new Error('The app was not saved')
  return appFromRow(rows[0])
}

export async function listMemberApps(db: DbClient): Promise<MemberAppRecord[]> {
  const { rows } = await db<MemberAppRow>`
    select id, name, redirect_uris_json, scopes_json, created_at
      from member_apps
     where deleted_at is null
     order by created_at
  `
  return rows.map(appFromRow)
}

export async function findMemberApp(db: DbClient, id: string): Promise<MemberAppRecord | null> {
  const { rows } = await db<MemberAppRow>`
    select id, name, redirect_uris_json, scopes_json, created_at
      from member_apps
     where id = ${id} and deleted_at is null
     limit 1
  `
  return rows[0] ? appFromRow(rows[0]) : null
}

/** Remove an app: it can no longer sign anyone in, and everyone it signed in is signed out of it. */
export async function deleteMemberApp(db: DbClient, id: string): Promise<boolean> {
  const now = nowIso()
  return db.transaction(async (tx) => {
    const removed = await tx`
      update member_apps set deleted_at = ${now} where id = ${id} and deleted_at is null
    `
    if (removed.rowCount !== 1) return false
    await tx`update member_app_grants set revoked_at = ${now} where app_id = ${id} and revoked_at is null`
    await tx`update member_app_tokens set revoked_at = ${now} where app_id = ${id} and revoked_at is null`
    return true
  })
}

// ─── Authorization requests ────────────────────────────────────────────────

export interface MemberAppRequest {
  appId: string
  appName: string
  redirectUri: string
  codeChallenge: string
  scope: string
  resource: string
  state: string | null
}

/** Store a checked authorization request and return the id the approval page is opened with. */
export async function createMemberAppRequest(
  db: DbClient,
  input: Omit<MemberAppRequest, 'appName'> & { browserMarker: string },
  now: Date = new Date(),
): Promise<string> {
  const id = generateOpaqueToken('imem_rq_')
  await db`
    insert into member_app_requests (
      id_hash, app_id, browser_hash, redirect_uri, code_challenge, scope, resource, state, created_at, expires_at
    )
    values (
      ${await hashOpaqueToken(id)}, ${input.appId}, ${await hashOpaqueToken(input.browserMarker)},
      ${input.redirectUri}, ${input.codeChallenge},
      ${input.scope}, ${input.resource}, ${input.state}, ${now.toISOString()},
      ${new Date(now.getTime() + REQUEST_TTL_MS).toISOString()}
    )
  `
  return id
}

interface MemberAppRequestRow {
  app_id: string
  app_name: string
  redirect_uri: string
  code_challenge: string
  scope: string
  resource: string
  state: string | null
}

/** A request that is still waiting for its answer, or null. */
export async function findPendingMemberAppRequest(
  db: DbClient,
  requestId: string,
  now: Date = new Date(),
): Promise<MemberAppRequest | null> {
  const { rows } = await db<MemberAppRequestRow>`
    select r.app_id, a.name as app_name, r.redirect_uri, r.code_challenge, r.scope, r.resource, r.state
      from member_app_requests r
      join member_apps a on a.id = r.app_id
     where r.id_hash = ${await hashOpaqueToken(requestId)}
       and r.decided_at is null
       and r.expires_at > ${now.toISOString()}
       and a.deleted_at is null
     limit 1
  `
  const row = rows[0]
  return row
    ? {
        appId: row.app_id,
        appName: row.app_name,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        scope: row.scope,
        resource: row.resource,
        state: row.state,
      }
    : null
}

/**
 * Answer a waiting request. An approval creates the grant and the one-time
 * code the app exchanges; a refusal only closes the request. Null when the
 * request was already answered, has run out, or the answer comes from a
 * browser other than the one the app opened.
 */
export async function decideMemberAppRequest(
  db: DbClient,
  input: { requestId: string; browserMarker: string; memberId: string; approve: boolean },
  now: Date = new Date(),
): Promise<{ request: MemberAppRequest; code: string | null } | null> {
  const idHash = await hashOpaqueToken(input.requestId)
  const browserHash = await hashOpaqueToken(input.browserMarker)
  return db.transaction(async (tx) => {
    const request = await findPendingMemberAppRequest(tx, input.requestId, now)
    if (!request) return null
    const decided = await tx`
      update member_app_requests set decided_at = ${now.toISOString()}
       where id_hash = ${idHash} and decided_at is null and browser_hash = ${browserHash}
    `
    if (decided.rowCount !== 1) return null
    if (!input.approve) return { request, code: null }

    const grantId = nanoid()
    await tx`
      insert into member_app_grants (id, member_id, app_id, scope, created_at, expires_at)
      values (
        ${grantId}, ${input.memberId}, ${request.appId}, ${request.scope}, ${now.toISOString()},
        ${new Date(now.getTime() + GRANT_TTL_MS).toISOString()}
      )
    `
    const code = generateOpaqueToken('imem_ac_')
    await tx`
      insert into member_app_codes (
        code_hash, grant_id, app_id, redirect_uri, code_challenge, scope, resource, expires_at
      )
      values (
        ${await hashOpaqueToken(code)}, ${grantId}, ${request.appId}, ${request.redirectUri},
        ${request.codeChallenge}, ${request.scope}, ${request.resource},
        ${new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS).toISOString()}
      )
    `
    return { request, code }
  })
}

// ─── Grants and tokens ─────────────────────────────────────────────────────

export interface MemberAppAccess {
  grantId: string
  memberId: string
  appId: string
  scope: string
}

/** The grant behind a live access token, or null. */
export async function findMemberAppAccess(
  db: DbClient,
  token: string,
  resource: string,
  now: Date = new Date(),
): Promise<MemberAppAccess | null> {
  const iso = now.toISOString()
  const { rows } = await db<{ grant_id: string; member_id: string; app_id: string; scope: string }>`
    select t.grant_id, g.member_id, t.app_id, t.scope
      from member_app_tokens t
      join member_app_grants g on g.id = t.grant_id
      join members m on m.id = g.member_id
     where t.token_hash = ${await hashOpaqueToken(token)}
       and t.kind = 'access'
       and t.resource = ${resource}
       and t.revoked_at is null and t.expires_at > ${iso}
       and g.revoked_at is null and g.expires_at > ${iso}
       and m.status = 'active' and m.deleted_at is null
     limit 1
  `
  const row = rows[0]
  return row ? { grantId: row.grant_id, memberId: row.member_id, appId: row.app_id, scope: row.scope } : null
}

export async function touchMemberAppGrant(db: DbClient, grantId: string): Promise<void> {
  await db`update member_app_grants set last_used_at = ${nowIso()} where id = ${grantId}`
}

async function revokeGrantRows(tx: DbClient, grantId: string, iso: string): Promise<void> {
  await tx`update member_app_grants set revoked_at = ${iso} where id = ${grantId} and revoked_at is null`
  await tx`update member_app_tokens set revoked_at = ${iso} where grant_id = ${grantId} and revoked_at is null`
}

/**
 * The app signs out: revoke the grant a token belongs to. Works with an
 * access or a refresh token, and only for the app that holds it.
 */
export async function revokeMemberAppGrantByToken(db: DbClient, token: string, appId: string): Promise<void> {
  const { rows } = await db<{ grant_id: string }>`
    select grant_id from member_app_tokens
     where token_hash = ${await hashOpaqueToken(token)} and app_id = ${appId}
     limit 1
  `
  const grantId = rows[0]?.grant_id
  if (grantId) await db.transaction((tx) => revokeGrantRows(tx, grantId, nowIso()))
}

/** Sign a member out of every app, e.g. after a password reset. */
export async function revokeAllMemberAppGrants(db: DbClient, memberId: string): Promise<void> {
  const iso = nowIso()
  await db.transaction(async (tx) => {
    await tx`
      update member_app_tokens set revoked_at = ${iso}
       where revoked_at is null
         and grant_id in (select id from member_app_grants where member_id = ${memberId})
    `
    await tx`update member_app_grants set revoked_at = ${iso} where member_id = ${memberId} and revoked_at is null`
  })
}

// ─── The realm ─────────────────────────────────────────────────────────────

interface CodeRow {
  grant_id: string
  app_id: string
  redirect_uri: string
  code_challenge: string
  scope: string
  resource: string
  expires_at: string
  consumed_at: string | null
  grant_expires_at: string | null
  grant_revoked_at: string | null
}

interface RefreshRow {
  id: string
  grant_id: string
  app_id: string
  scope: string
  resource: string
  expires_at: string
  revoked_at: string | null
  grant_expires_at: string | null
  grant_revoked_at: string | null
}

function memberAppGrantStore(tx: DbClient): GrantStore {
  return {
    async findAuthorizationCode(codeHash): Promise<StoredAuthorizationCode | null> {
      const { rows } = await tx<CodeRow>`
        select c.grant_id, c.app_id, c.redirect_uri, c.code_challenge, c.scope, c.resource,
               c.expires_at, c.consumed_at,
               g.expires_at as grant_expires_at, g.revoked_at as grant_revoked_at
          from member_app_codes c
          join member_app_grants g on g.id = c.grant_id
          join members m on m.id = g.member_id
          join member_apps a on a.id = c.app_id
         where c.code_hash = ${codeHash}
           and m.status = 'active' and m.deleted_at is null
           and a.deleted_at is null
         limit 1
      `
      const row = rows[0]
      return row
        ? {
            grantId: row.grant_id,
            clientId: row.app_id,
            redirectUri: row.redirect_uri,
            codeChallenge: row.code_challenge,
            scope: row.scope,
            resource: row.resource,
            expiresAt: row.expires_at,
            consumedAt: row.consumed_at,
            grantExpiresAt: row.grant_expires_at,
            grantRevokedAt: row.grant_revoked_at,
          }
        : null
    },

    async consumeAuthorizationCode(codeHash, now) {
      const consumed = await tx`
        update member_app_codes set consumed_at = ${now.toISOString()}
         where code_hash = ${codeHash} and consumed_at is null
      `
      return consumed.rowCount === 1
    },

    async findRefreshToken(tokenHash): Promise<StoredRefreshToken | null> {
      const { rows } = await tx<RefreshRow>`
        select t.id, t.grant_id, t.app_id, t.scope, t.resource, t.expires_at, t.revoked_at,
               g.expires_at as grant_expires_at, g.revoked_at as grant_revoked_at
          from member_app_tokens t
          join member_app_grants g on g.id = t.grant_id
          join members m on m.id = g.member_id
         where t.token_hash = ${tokenHash} and t.kind = 'refresh'
           and m.status = 'active' and m.deleted_at is null
         limit 1
      `
      const row = rows[0]
      return row
        ? {
            id: row.id,
            grantId: row.grant_id,
            clientId: row.app_id,
            scope: row.scope,
            resource: row.resource,
            expiresAt: row.expires_at,
            revokedAt: row.revoked_at,
            grantExpiresAt: row.grant_expires_at,
            grantRevokedAt: row.grant_revoked_at,
          }
        : null
    },

    async revokeToken(tokenId, now) {
      const revoked = await tx`
        update member_app_tokens set revoked_at = ${now.toISOString()}
         where id = ${tokenId} and revoked_at is null
      `
      return revoked.rowCount === 1
    },

    revokeGrant: (grantId, now) => revokeGrantRows(tx, grantId, now.toISOString()),

    async insertToken(token) {
      await tx`
        insert into member_app_tokens (
          id, grant_id, app_id, kind, token_hash, scope, resource, created_at, expires_at
        )
        values (
          ${nanoid()}, ${token.grantId}, ${token.clientId}, ${token.kind}, ${token.tokenHash},
          ${token.scope}, ${token.resource}, ${nowIso()}, ${token.expiresAt.toISOString()}
        )
      `
    },
  }
}

/** The authorization server apps sign a site member in with. */
export const memberAppRealm: OAuthRealm = {
  logName: 'members:apps',
  accessTokenPrefix: 'imem_at_',
  refreshTokenPrefix: 'imem_rt_',
  accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  normalizeScope: normalizeMemberAppScope,
  store: memberAppGrantStore,
}
