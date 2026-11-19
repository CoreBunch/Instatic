import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { DbClient } from '../db/client'
import {
  exchangeAuthorizationCode,
  REFRESH_RETRY_GRACE_MS,
  rotateRefreshToken,
  type GrantStore,
  type NewStoredToken,
  type OAuthRealm,
  type StoredAuthorizationCode,
} from './grants'
import { hashOpaqueToken, pkceChallengeForVerifier } from './secrets'

const NOW = new Date('2026-01-01T00:00:00.000Z')
const CODE_TTL_MS = 5 * 60 * 1000
const GRANT_EXPIRES_AT = new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000)
const VERIFIER = 'a'.repeat(64)
const EXCHANGE = {
  code: 'the-code',
  clientId: 'client-1',
  redirectUri: 'https://client.example/callback',
  codeVerifier: VERIFIER,
  resource: 'https://cms.example.com/resource',
}

function minutesAfter(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60 * 1000)
}

/**
 * One grant held in memory: its code, its tokens, and whether it was revoked.
 * This is a realm whose grants are never bound to a key.
 */
class MemoryGrantStore implements GrantStore {
  grantRevokedAt: string | null = null
  /** The key the grant is bound to. Only `KeyedMemoryGrantStore` ever sets it. */
  keyThumbprint: string | null = null
  code: (StoredAuthorizationCode & { codeHash: string }) | null = null
  tokens: Array<NewStoredToken & { id: string; revokedAt: string | null }> = []

  async findAuthorizationCode(codeHash: string) {
    if (this.code?.codeHash !== codeHash) return null
    return { ...this.code, grantRevokedAt: this.grantRevokedAt, keyThumbprint: this.keyThumbprint }
  }

  async consumeAuthorizationCode(codeHash: string, now: Date) {
    if (this.code?.codeHash !== codeHash || this.code.consumedAt) return false
    this.code.consumedAt = now.toISOString()
    return true
  }

  async findRefreshToken(tokenHash: string) {
    const token = this.tokens.find((t) => t.kind === 'refresh' && t.tokenHash === tokenHash)
    if (!token) return null
    return {
      id: token.id,
      grantId: token.grantId,
      clientId: token.clientId,
      scope: token.scope,
      resource: token.resource,
      expiresAt: token.expiresAt.toISOString(),
      revokedAt: token.revokedAt,
      grantExpiresAt: GRANT_EXPIRES_AT.toISOString(),
      grantRevokedAt: this.grantRevokedAt,
      keyThumbprint: this.keyThumbprint,
    }
  }

  async revokeToken(tokenId: string, now: Date) {
    const token = this.tokens.find((t) => t.id === tokenId)
    if (!token || token.revokedAt) return false
    token.revokedAt = now.toISOString()
    return true
  }

  async revokeGrant(_grantId: string, now: Date) {
    this.grantRevokedAt = now.toISOString()
    for (const token of this.tokens) token.revokedAt ??= now.toISOString()
  }

  async insertToken(token: NewStoredToken) {
    this.tokens.push({ ...token, id: `token-${this.tokens.length + 1}`, revokedAt: null })
  }

  liveTokens() {
    return this.tokens.filter((t) => !t.revokedAt)
  }
}

/** The same grant in a realm whose grants can be bound to a key. */
class KeyedMemoryGrantStore extends MemoryGrantStore {
  async keyShownAtExchange(_grantId: string, keyThumbprint: string) {
    this.keyThumbprint ??= keyThumbprint
  }

  async revokeGrantTokens(_grantId: string, now: Date) {
    const live = this.liveTokens()
    for (const token of live) token.revokedAt = now.toISOString()
    return live.length > 0
  }
}

let store: MemoryGrantStore
let code: NonNullable<MemoryGrantStore['code']>
let realm: OAuthRealm
let warn: ReturnType<typeof spyOn>
// The engine only opens a transaction; the store never touches the client.
const db = { transaction: <T>(fn: (tx: DbClient) => Promise<T>) => fn(db) } as unknown as DbClient

beforeEach(async () => {
  warn = spyOn(console, 'warn').mockImplementation(() => {})
  store = new MemoryGrantStore()
  code = {
    codeHash: await hashOpaqueToken(EXCHANGE.code),
    grantId: 'grant-1',
    clientId: EXCHANGE.clientId,
    redirectUri: EXCHANGE.redirectUri,
    codeChallenge: await pkceChallengeForVerifier(VERIFIER),
    scope: 'read write',
    resource: EXCHANGE.resource,
    expiresAt: new Date(NOW.getTime() + CODE_TTL_MS).toISOString(),
    consumedAt: null,
    grantExpiresAt: GRANT_EXPIRES_AT.toISOString(),
    grantRevokedAt: null,
    keyThumbprint: null,
  }
  store.code = code
  realm = {
    logName: 'test:oauth',
    accessTokenPrefix: 'test_at_',
    refreshTokenPrefix: 'test_rt_',
    accessTokenTtlSeconds: 3600,
    normalizeScope: (raw) => raw ?? null,
    store: () => store,
  }
})

afterEach(() => {
  warn.mockRestore()
})

describe('exchangeAuthorizationCode', () => {
  it('consumes the code and issues an access and a refresh token', async () => {
    const tokens = await exchangeAuthorizationCode(db, realm, EXCHANGE, NOW)

    expect(tokens?.accessToken).toMatch(/^test_at_/)
    expect(tokens?.refreshToken).toMatch(/^test_rt_/)
    expect(tokens?.scope).toBe('read write')
    expect(tokens?.expiresIn).toBe(3600)
    expect(store.code?.consumedAt).toBe(NOW.toISOString())
    expect(store.tokens.map((t) => t.kind)).toEqual(['access', 'refresh'])
    expect(store.tokens[0]!.tokenHash).toBe(await hashOpaqueToken(tokens!.accessToken))
    expect(store.tokens[1]!.expiresAt).toEqual(GRANT_EXPIRES_AT)
  })

  it('revokes the grant when an unexpired code is presented again', async () => {
    await exchangeAuthorizationCode(db, realm, EXCHANGE, NOW)

    expect(await exchangeAuthorizationCode(db, realm, EXCHANGE, minutesAfter(1))).toBeNull()
    expect(store.grantRevokedAt).toBe(minutesAfter(1).toISOString())
    expect(store.liveTokens()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('leaves the grant alone when the replay names another client', async () => {
    await exchangeAuthorizationCode(db, realm, EXCHANGE, NOW)

    expect(await exchangeAuthorizationCode(db, realm, { ...EXCHANGE, clientId: 'client-2' }, minutesAfter(1))).toBeNull()
    expect(store.grantRevokedAt).toBeNull()
    expect(store.liveTokens()).toHaveLength(2)
  })

  it('refuses an expired code presented again without revoking anything', async () => {
    await exchangeAuthorizationCode(db, realm, EXCHANGE, NOW)

    expect(await exchangeAuthorizationCode(db, realm, EXCHANGE, minutesAfter(6))).toBeNull()
    expect(store.grantRevokedAt).toBeNull()
    expect(store.liveTokens()).toHaveLength(2)
    expect(warn).not.toHaveBeenCalled()
  })

  it('refuses an expired code that was never used', async () => {
    expect(await exchangeAuthorizationCode(db, realm, EXCHANGE, minutesAfter(6))).toBeNull()
    expect(store.code?.consumedAt).toBeNull()
    expect(store.tokens).toEqual([])
  })
})

describe('rotateRefreshToken', () => {
  it('revokes the presented refresh token and issues a new pair', async () => {
    const initial = await exchangeAuthorizationCode(db, realm, EXCHANGE, NOW)

    const rotated = await rotateRefreshToken(db, realm, {
      refreshToken: initial!.refreshToken,
      clientId: EXCHANGE.clientId,
      resource: EXCHANGE.resource,
      scope: 'read',
    }, minutesAfter(10))

    expect(rotated?.refreshToken).not.toBe(initial!.refreshToken)
    expect(rotated?.scope).toBe('read')
    expect(store.grantRevokedAt).toBeNull()
    const oldRefresh = store.tokens.find((t) => t.kind === 'refresh' && t.scope === 'read write')
    expect(oldRefresh?.revokedAt).toBe(minutesAfter(10).toISOString())
    expect(store.liveTokens().map((t) => t.kind)).toEqual(['access', 'access', 'refresh'])
  })

  it('refuses a scope wider than the token holds', async () => {
    const initial = await exchangeAuthorizationCode(db, realm, EXCHANGE, NOW)

    expect(await rotateRefreshToken(db, realm, {
      refreshToken: initial!.refreshToken,
      clientId: EXCHANGE.clientId,
      resource: EXCHANGE.resource,
      scope: 'read admin',
    }, minutesAfter(10))).toBeNull()
    expect(store.liveTokens()).toHaveLength(2)
  })

  it('revokes the grant when a rotated refresh token is presented again', async () => {
    const initial = await exchangeAuthorizationCode(db, realm, EXCHANGE, NOW)
    const refresh = { refreshToken: initial!.refreshToken, clientId: EXCHANGE.clientId, resource: EXCHANGE.resource }
    expect(await rotateRefreshToken(db, realm, refresh, minutesAfter(10))).not.toBeNull()

    expect(await rotateRefreshToken(db, realm, refresh, minutesAfter(20))).toBeNull()
    expect(store.grantRevokedAt).toBe(minutesAfter(20).toISOString())
    expect(store.liveTokens()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('a grant bound to a key', () => {
  const KEY = 'thumbprint-of-the-device-key'
  const OTHER_KEY = 'thumbprint-of-another-key'
  const secondsAfter = (from: Date, seconds: number) => new Date(from.getTime() + seconds * 1000)

  beforeEach(() => {
    store = new KeyedMemoryGrantStore()
    store.code = code
  })

  function refreshWith(refreshToken: string, proofThumbprint?: string) {
    return { refreshToken, clientId: EXCHANGE.clientId, resource: EXCHANGE.resource, proofThumbprint }
  }

  it('binds an unbound grant to the key that proved itself at the exchange', async () => {
    expect(await exchangeAuthorizationCode(db, realm, { ...EXCHANGE, proofThumbprint: KEY }, NOW)).not.toBeNull()
    expect(store.keyThumbprint).toBe(KEY)
  })

  it('leaves the grant unbound when the exchange carried no proof', async () => {
    const initial = await exchangeAuthorizationCode(db, realm, EXCHANGE, NOW)
    expect(store.keyThumbprint).toBeNull()

    // A proof on a later refresh does not bind it.
    expect(await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken, KEY), minutesAfter(10))).not.toBeNull()
    expect(store.keyThumbprint).toBeNull()
  })

  it('never binds in a realm that has no keys', async () => {
    store = new MemoryGrantStore()
    store.code = code
    expect(await exchangeAuthorizationCode(db, realm, { ...EXCHANGE, proofThumbprint: KEY }, NOW)).not.toBeNull()
    expect(store.keyThumbprint).toBeNull()
  })

  it('gives the code of a grant bound at approval only to its key', async () => {
    store.keyThumbprint = KEY

    expect(await exchangeAuthorizationCode(db, realm, EXCHANGE, NOW)).toBeNull()
    expect(await exchangeAuthorizationCode(db, realm, { ...EXCHANGE, proofThumbprint: OTHER_KEY }, NOW)).toBeNull()
    expect(store.code?.consumedAt).toBeNull()
    expect(await exchangeAuthorizationCode(db, realm, { ...EXCHANGE, proofThumbprint: KEY }, NOW)).not.toBeNull()
  })

  it('revokes on a replayed code only when the replay holds the key', async () => {
    await exchangeAuthorizationCode(db, realm, { ...EXCHANGE, proofThumbprint: KEY }, NOW)

    expect(await exchangeAuthorizationCode(db, realm, EXCHANGE, minutesAfter(1))).toBeNull()
    expect(store.grantRevokedAt).toBeNull()
    expect(store.liveTokens()).toHaveLength(2)

    expect(await exchangeAuthorizationCode(db, realm, { ...EXCHANGE, proofThumbprint: KEY }, minutesAfter(1))).toBeNull()
    expect(store.grantRevokedAt).toBe(minutesAfter(1).toISOString())
  })

  it('refuses a refresh token shown without the key and leaves the grant alone', async () => {
    const initial = await exchangeAuthorizationCode(db, realm, { ...EXCHANGE, proofThumbprint: KEY }, NOW)

    expect(await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken), minutesAfter(10))).toBeNull()
    expect(await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken, OTHER_KEY), minutesAfter(10))).toBeNull()
    expect(store.grantRevokedAt).toBeNull()
    expect(store.liveTokens()).toHaveLength(2)

    // A spent token without the key ends nothing either.
    const spentAt = minutesAfter(10)
    expect(await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken, KEY), spentAt)).not.toBeNull()
    expect(await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken), minutesAfter(20))).toBeNull()
    expect(store.grantRevokedAt).toBeNull()
  })

  it('answers a retry of a spent refresh token within the grace, replacing the lost pair', async () => {
    const initial = await exchangeAuthorizationCode(db, realm, { ...EXCHANGE, proofThumbprint: KEY }, NOW)
    const spentAt = minutesAfter(10)
    await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken, KEY), spentAt)

    const retryAt = secondsAfter(spentAt, REFRESH_RETRY_GRACE_MS / 1000)
    const retried = await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken, KEY), retryAt)

    expect(retried).not.toBeNull()
    expect(store.grantRevokedAt).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    // Only the retried pair works: what the lost answer carried is withdrawn.
    expect(store.liveTokens().map((t) => t.tokenHash).sort()).toEqual(
      [await hashOpaqueToken(retried!.accessToken), await hashOpaqueToken(retried!.refreshToken)].sort(),
    )
  })

  it('treats a spent refresh token as reuse once the grace has passed', async () => {
    const initial = await exchangeAuthorizationCode(db, realm, { ...EXCHANGE, proofThumbprint: KEY }, NOW)
    const spentAt = minutesAfter(10)
    await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken, KEY), spentAt)

    const late = secondsAfter(spentAt, REFRESH_RETRY_GRACE_MS / 1000 + 1)
    expect(await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken, KEY), late)).toBeNull()
    expect(store.grantRevokedAt).toBe(late.toISOString())
    expect(store.liveTokens()).toEqual([])
  })

  it('answers a retry only when it withdraws a live token', async () => {
    const initial = await exchangeAuthorizationCode(db, realm, { ...EXCHANGE, proofThumbprint: KEY }, NOW)
    const spentAt = minutesAfter(10)
    await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken, KEY), spentAt)
    for (const token of store.liveTokens()) token.revokedAt = spentAt.toISOString()

    expect(await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken, KEY), secondsAfter(spentAt, 5))).toBeNull()
    expect(store.liveTokens()).toEqual([])
    expect(store.grantRevokedAt).toBeNull()
  })

  it('gives an unbound grant no retry: reuse revokes it at once', async () => {
    const initial = await exchangeAuthorizationCode(db, realm, EXCHANGE, NOW)
    const spentAt = minutesAfter(10)
    await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken), spentAt)

    expect(await rotateRefreshToken(db, realm, refreshWith(initial!.refreshToken), secondsAfter(spentAt, 5))).toBeNull()
    expect(store.grantRevokedAt).toBe(secondsAfter(spentAt, 5).toISOString())
  })
})
