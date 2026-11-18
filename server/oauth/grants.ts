/**
 * The two token grants of an OAuth authorization server: exchanging an
 * authorization code and rotating a refresh token.
 *
 * The steps are the same whoever the grant belongs to. What differs is where
 * the rows live and who counts as a live subject, so each authorization
 * server (a "realm") supplies its own `GrantStore`; this file never names a
 * table. A store only returns a code or a token whose subject is still
 * allowed to use it.
 */
import type { DbClient } from '../db/client'
import { isValidPkceVerifier, scopeIsSubset } from './protocol'
import { generateOpaqueToken, hashOpaqueToken, pkceChallengeForVerifier } from './secrets'

/** An authorization code as stored, with the state of the grant it belongs to. */
export interface StoredAuthorizationCode {
  grantId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  scope: string
  resource: string
  expiresAt: string
  consumedAt: string | null
  grantExpiresAt: string | null
  grantRevokedAt: string | null
}

/** A refresh token as stored, with the state of the grant it belongs to. */
export interface StoredRefreshToken {
  id: string
  grantId: string
  clientId: string
  scope: string
  resource: string
  expiresAt: string
  revokedAt: string | null
  grantExpiresAt: string | null
  grantRevokedAt: string | null
}

export interface NewStoredToken {
  grantId: string
  clientId: string
  kind: 'access' | 'refresh'
  tokenHash: string
  scope: string
  resource: string
  expiresAt: Date
}

/** A realm's rows, bound to one transaction. */
export interface GrantStore {
  findAuthorizationCode(codeHash: string): Promise<StoredAuthorizationCode | null>
  /** Marks the code used. False when another request used it first. */
  consumeAuthorizationCode(codeHash: string, now: Date): Promise<boolean>
  findRefreshToken(tokenHash: string): Promise<StoredRefreshToken | null>
  /** Revokes one token. False when it was already revoked. */
  revokeToken(tokenId: string, now: Date): Promise<boolean>
  /** Revokes the grant and every token issued under it. */
  revokeGrant(grantId: string, now: Date): Promise<void>
  insertToken(token: NewStoredToken): Promise<void>
}

export interface OAuthRealm {
  /** Prefix of this realm's log lines, e.g. `ai:mcp:oauth`. */
  logName: string
  accessTokenPrefix: string
  refreshTokenPrefix: string
  accessTokenTtlSeconds: number
  /** The scope string in this realm's canonical form, or null when it asks for something unknown. */
  normalizeScope(raw: string | undefined): string | null
  store(tx: DbClient): GrantStore
}

export interface OAuthTokenPair {
  accessToken: string
  refreshToken: string
  scope: string
  expiresIn: number
}

function isPast(timestamp: string | null, now: Date): boolean {
  return !timestamp || new Date(timestamp).getTime() <= now.getTime()
}

export async function exchangeAuthorizationCode(
  db: DbClient,
  realm: OAuthRealm,
  input: {
    code: string
    clientId: string
    redirectUri: string
    codeVerifier: string
    resource: string
  },
  now: Date = new Date(),
): Promise<OAuthTokenPair | null> {
  if (!isValidPkceVerifier(input.codeVerifier)) return null
  const codeHash = await hashOpaqueToken(input.code)
  const challenge = await pkceChallengeForVerifier(input.codeVerifier)

  return db.transaction(async (tx) => {
    const store = realm.store(tx)
    const code = await store.findAuthorizationCode(codeHash)
    if (
      !code || code.consumedAt || code.grantRevokedAt ||
      isPast(code.expiresAt, now) || isPast(code.grantExpiresAt, now) ||
      code.clientId !== input.clientId || code.redirectUri !== input.redirectUri ||
      code.resource !== input.resource || code.codeChallenge !== challenge
    ) {
      return null
    }
    if (!(await store.consumeAuthorizationCode(codeHash, now))) return null

    return issueTokenPair(store, realm, {
      grantId: code.grantId,
      clientId: code.clientId,
      scope: code.scope,
      resource: code.resource,
      grantExpiresAt: new Date(code.grantExpiresAt!),
      now,
    })
  })
}

export async function rotateRefreshToken(
  db: DbClient,
  realm: OAuthRealm,
  input: {
    refreshToken: string
    clientId: string
    resource: string
    scope?: string
  },
  now: Date = new Date(),
): Promise<OAuthTokenPair | null> {
  const tokenHash = await hashOpaqueToken(input.refreshToken)

  return db.transaction(async (tx) => {
    const store = realm.store(tx)
    const token = await store.findRefreshToken(tokenHash)
    const requestedScope = realm.normalizeScope(input.scope ?? token?.scope)

    // A rotated refresh token should never be presented again. Treat reuse as
    // credential theft and revoke the entire grant, including access tokens
    // minted from the replacement token. The client must re-authorize.
    if (token?.revokedAt && !token.grantRevokedAt) {
      await store.revokeGrant(token.grantId, now)
      console.warn(`[${realm.logName}] refresh-token reuse revoked grant ${token.grantId}`)
      return null
    }
    if (
      !token || token.revokedAt || token.grantRevokedAt || !requestedScope ||
      isPast(token.expiresAt, now) || isPast(token.grantExpiresAt, now) ||
      token.clientId !== input.clientId || token.resource !== input.resource ||
      !scopeIsSubset(requestedScope, token.scope)
    ) {
      return null
    }
    if (!(await store.revokeToken(token.id, now))) return null

    return issueTokenPair(store, realm, {
      grantId: token.grantId,
      clientId: token.clientId,
      scope: requestedScope,
      resource: token.resource,
      grantExpiresAt: new Date(token.grantExpiresAt!),
      now,
    })
  })
}

async function issueTokenPair(
  store: GrantStore,
  realm: OAuthRealm,
  input: {
    grantId: string
    clientId: string
    scope: string
    resource: string
    grantExpiresAt: Date
    now: Date
  },
): Promise<OAuthTokenPair> {
  const accessToken = generateOpaqueToken(realm.accessTokenPrefix)
  const refreshToken = generateOpaqueToken(realm.refreshTokenPrefix)
  // An access token never outlives the grant it was issued under.
  const accessExpiresAt = new Date(Math.min(
    input.now.getTime() + realm.accessTokenTtlSeconds * 1000,
    input.grantExpiresAt.getTime(),
  ))
  const expiresIn = Math.max(1, Math.floor((accessExpiresAt.getTime() - input.now.getTime()) / 1000))
  const shared = { grantId: input.grantId, clientId: input.clientId, scope: input.scope, resource: input.resource }

  await store.insertToken({
    ...shared, kind: 'access', tokenHash: await hashOpaqueToken(accessToken), expiresAt: accessExpiresAt,
  })
  await store.insertToken({
    ...shared, kind: 'refresh', tokenHash: await hashOpaqueToken(refreshToken), expiresAt: input.grantExpiresAt,
  })

  return { accessToken, refreshToken, scope: input.scope, expiresIn }
}
