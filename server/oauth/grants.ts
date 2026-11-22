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
  /** The grant belongs to the holder of this key (a DPoP thumbprint); null when it is not bound to one. */
  keyThumbprint: string | null
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
  /** See `StoredAuthorizationCode.keyThumbprint`. */
  keyThumbprint: string | null
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
  /**
   * Only in a realm whose grants can be bound to a key. Called at the code
   * exchange when the request carried a valid proof: binds the grant to that
   * key if it has none yet, and does whatever the realm ties to a key having
   * been shown (the caller has already checked a bound grant against it).
   */
  keyShownAtExchange?(grantId: string, keyThumbprint: string, now: Date): Promise<void>
  /**
   * Only in a realm whose grants can be bound to a key. Revokes every live
   * token of the grant and leaves the grant itself standing. Answers whether
   * there was a live token to revoke.
   */
  revokeGrantTokens?(grantId: string, now: Date): Promise<boolean>
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

/**
 * A refresh whose answer never arrived (a timeout, a laptop going to sleep)
 * leaves the client holding a token the server has already spent. For this
 * long after a rotation, the holder of the grant's key may present the spent
 * token again and is given a new pair instead of losing the grant.
 */
export const REFRESH_RETRY_GRACE_MS = 60 * 1000

/** A grant bound to a key is used only with a proof from that key. An unbound grant asks for none. */
function holdsKey(boundTo: string | null, proofThumbprint: string | null | undefined): boolean {
  return boundTo === null || boundTo === proofThumbprint
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
    /** The key that signed this request's DPoP proof, when it carried a valid one. */
    proofThumbprint?: string | null
  },
  now: Date = new Date(),
): Promise<OAuthTokenPair | null> {
  if (!isValidPkceVerifier(input.codeVerifier)) return null
  const codeHash = await hashOpaqueToken(input.code)
  const challenge = await pkceChallengeForVerifier(input.codeVerifier)

  return db.transaction(async (tx) => {
    const store = realm.store(tx)
    const code = await store.findAuthorizationCode(codeHash)
    // A code is used once. Seeing it again while it could still have been
    // exchanged means it leaked or was replayed, so everything issued from it
    // is withdrawn too (RFC 6749 §4.1.2). The request must name the client the
    // code was issued to, but a client id is public, so that is no proof of who
    // is asking. Two things limit it. The expiry bound: consumed codes are
    // kept, and one found later in a browser history or a log is refused below
    // without touching the grant. And for a grant bound to a key, only the
    // holder of that key: a used code someone came across must not be enough
    // to sign the device out.
    if (
      code?.consumedAt && !code.grantRevokedAt &&
      !isPast(code.expiresAt, now) && code.clientId === input.clientId &&
      holdsKey(code.keyThumbprint, input.proofThumbprint)
    ) {
      await store.revokeGrant(code.grantId, now)
      console.warn(`[${realm.logName}] authorization-code replay revoked grant ${code.grantId}`)
      return null
    }
    if (
      !code || code.consumedAt || code.grantRevokedAt ||
      isPast(code.expiresAt, now) || isPast(code.grantExpiresAt, now) ||
      code.clientId !== input.clientId || code.redirectUri !== input.redirectUri ||
      code.resource !== input.resource || code.codeChallenge !== challenge ||
      !holdsKey(code.keyThumbprint, input.proofThumbprint)
    ) {
      return null
    }
    if (!(await store.consumeAuthorizationCode(codeHash, now))) return null
    // A proof at the exchange is the client saying "this is my key". A grant
    // that was not bound when it was approved (the client left `dpop_jkt` off
    // the sign-in address, or something dropped it) is bound here, so the
    // client that believes it is bound is (RFC 9449 §5).
    if (input.proofThumbprint) await store.keyShownAtExchange?.(code.grantId, input.proofThumbprint, now)

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
    /** The key that signed this request's DPoP proof, when it carried a valid one. */
    proofThumbprint?: string | null
  },
  now: Date = new Date(),
): Promise<OAuthTokenPair | null> {
  const tokenHash = await hashOpaqueToken(input.refreshToken)

  return db.transaction(async (tx) => {
    const store = realm.store(tx)
    const token = await store.findRefreshToken(tokenHash)
    const requestedScope = realm.normalizeScope(input.scope ?? token?.scope)

    // A grant bound to a key answers only its holder. A refresh token shown
    // without the key is a copy: refuse it, and leave the grant alone, so
    // whoever copied it cannot sign the real device out either.
    if (token && !holdsKey(token.keyThumbprint, input.proofThumbprint)) return null

    // A rotated refresh token should never be presented again. Treat reuse as
    // credential theft and revoke the entire grant, including access tokens
    // minted from the replacement token. The client must re-authorize.
    //
    // The one exception is a retry: the grant is bound to a key, this request
    // proved that key (checked above), and the token was spent moments ago.
    // That is the device asking again because the answer never reached it.
    const spent = Boolean(token?.revokedAt) && !token?.grantRevokedAt
    const retry = spent && token?.keyThumbprint != null && store.revokeGrantTokens !== undefined &&
      now.getTime() - new Date(token.revokedAt!).getTime() <= REFRESH_RETRY_GRACE_MS
    if (token && spent && !retry) {
      await store.revokeGrant(token.grantId, now)
      console.warn(`[${realm.logName}] refresh-token reuse revoked grant ${token.grantId}`)
      return null
    }
    if (
      !token || (token.revokedAt && !retry) || token.grantRevokedAt || !requestedScope ||
      isPast(token.expiresAt, now) || isPast(token.grantExpiresAt, now) ||
      token.clientId !== input.clientId || token.resource !== input.resource ||
      !scopeIsSubset(requestedScope, token.scope)
    ) {
      return null
    }
    if (retry) {
      // Whatever the lost answer carried is withdrawn; the pair issued below
      // is the only one that works. A retry replaces a pair that is still
      // live: with nothing live to withdraw there is no lost answer to make
      // up for, and two retries racing each other cannot both be answered
      // from the same state.
      if (!(await store.revokeGrantTokens!(token.grantId, now))) return null
    } else if (!(await store.revokeToken(token.id, now))) {
      return null
    }

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
