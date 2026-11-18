/**
 * The keys this site signs offline statements with.
 *
 * A statement is what lets an app keep working without a connection: a
 * short document saying who the member is and what they hold, signed here
 * and checked by the app against the public key it fetched earlier. One
 * Ed25519 key pair is current at a time. The private half is stored
 * encrypted with the master key and never leaves this file; the public half
 * is published with its id so a statement names the key that signed it.
 *
 * Rotating makes a new key current and retires the old one. A retired key
 * stays published until the last statement it signed has run out, so an app
 * that is offline during a rotation is not locked out. That also means
 * rotating does not withdraw the old key at once: a statement signed with it
 * is accepted until it runs out.
 */
import { nanoid } from 'nanoid'
import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'
import { isoDate, isoDateOrNull, nowIso } from '@core/utils/isoDate'
import type { DbClient } from '../../db/client'
import { decryptSecret, encryptSecret } from '../../secrets/encryption'
import { getMasterKeyFingerprint, loadMasterKey } from '../../secrets/masterKey'

/** How long a statement is good for. A retired key is published this long, and no longer. */
export const STATEMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

const PublicKeySchema = Type.Object({
  kty: Type.Literal('OKP'),
  crv: Type.Literal('Ed25519'),
  x: Type.String({ minLength: 1 }),
})
type PublicKey = Static<typeof PublicKeySchema>

const PrivateKeySchema = Type.Object({
  kty: Type.Literal('OKP'),
  crv: Type.Literal('Ed25519'),
  x: Type.String({ minLength: 1 }),
  d: Type.String({ minLength: 1 }),
})

/** A key as an app sees it in the published key set (a JWK, RFC 7517). */
export interface PublishedSigningKey extends PublicKey {
  kid: string
  use: 'sig'
  alg: 'EdDSA'
}

export interface SigningKeyInfo {
  id: string
  createdAt: string
  retiredAt: string | null
  /** False when the master key changed since the key was made: it cannot sign until it is rotated. */
  usable: boolean
}

interface KeyRow {
  id: string
  public_jwk_json: unknown
  private_ciphertext: Uint8Array
  private_iv: Uint8Array
  key_fingerprint: string
  created_at: Date | string
  retired_at: Date | string | null
}

/** The stored private key cannot be read: the master key changed since it was made. */
export class SigningKeyUnreadableError extends Error {
  constructor() {
    super('The statement signing key was encrypted with a different master key. Rotate the signing key.')
    this.name = 'SigningKeyUnreadableError'
  }
}

function publicKeyOf(row: KeyRow): PublicKey {
  const parsed = safeParseValue(PublicKeySchema, row.public_jwk_json)
  if (!parsed.ok) throw new Error(`Signing key ${row.id} has no readable public key`)
  return { kty: parsed.value.kty, crv: parsed.value.crv, x: parsed.value.x }
}

async function insertNewKey(tx: DbClient): Promise<KeyRow> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const exported = safeParseValue(PrivateKeySchema, await crypto.subtle.exportKey('jwk', pair.privateKey))
  if (!exported.ok) throw new Error('The runtime did not produce an Ed25519 key')
  const publicJwk: PublicKey = { kty: 'OKP', crv: 'Ed25519', x: exported.value.x }
  const encrypted = await encryptSecret(await loadMasterKey(), exported.value.d)
  const { rows } = await tx<KeyRow>`
    insert into member_signing_keys (id, public_jwk_json, private_ciphertext, private_iv, key_fingerprint, created_at)
    values (
      ${`imem_key_${nanoid(16)}`}, ${publicJwk}, ${encrypted.ciphertext}, ${encrypted.iv},
      ${await getMasterKeyFingerprint()}, ${nowIso()}
    )
    returning id, public_jwk_json, private_ciphertext, private_iv, key_fingerprint, created_at, retired_at
  `
  if (!rows[0]) throw new Error('The signing key was not saved')
  return rows[0]
}

async function findCurrentKeyRow(db: DbClient): Promise<KeyRow | null> {
  const { rows } = await db<KeyRow>`
    select id, public_jwk_json, private_ciphertext, private_iv, key_fingerprint, created_at, retired_at
      from member_signing_keys
     where retired_at is null
     order by created_at desc, id
     limit 1
  `
  return rows[0] ?? null
}

/** The current key, made on first use. Reading it is a plain query; only making it opens a transaction. */
async function currentKeyRow(db: DbClient): Promise<KeyRow> {
  return (await findCurrentKeyRow(db)) ?? db.transaction(async (tx) => (await findCurrentKeyRow(tx)) ?? insertNewKey(tx))
}

async function infoOf(row: KeyRow): Promise<SigningKeyInfo> {
  return {
    id: row.id,
    createdAt: isoDate(row.created_at),
    retiredAt: isoDateOrNull(row.retired_at),
    usable: row.key_fingerprint === (await getMasterKeyFingerprint()),
  }
}

/** The key statements are signed with now. Made on first use. */
export async function getCurrentSigningKey(db: DbClient): Promise<SigningKeyInfo> {
  return infoOf(await currentKeyRow(db))
}

/** Retire the current key and make a new one. Statements already out stay checkable until they run out. */
export async function rotateSigningKey(db: DbClient): Promise<SigningKeyInfo> {
  const now = new Date()
  return db.transaction(async (tx) => {
    // A key retired longer ago than a statement lives signs nothing that is still valid.
    await tx`delete from member_signing_keys where retired_at <= ${new Date(now.getTime() - STATEMENT_TTL_MS).toISOString()}`
    await tx`update member_signing_keys set retired_at = ${now.toISOString()} where retired_at is null`
    return infoOf(await insertNewKey(tx))
  })
}

/** Every key an app may still need: the current one first, then retired ones whose statements can still be valid. */
export async function listPublishedSigningKeys(db: DbClient, now: Date = new Date()): Promise<PublishedSigningKey[]> {
  await currentKeyRow(db)
  const { rows } = await db<KeyRow>`
    select id, public_jwk_json, private_ciphertext, private_iv, key_fingerprint, created_at, retired_at
      from member_signing_keys
     where retired_at is null or retired_at > ${new Date(now.getTime() - STATEMENT_TTL_MS).toISOString()}
     order by case when retired_at is null then 0 else 1 end, created_at desc, id
  `
  return rows.map((row) => ({ ...publicKeyOf(row), kid: row.id, use: 'sig' as const, alg: 'EdDSA' as const }))
}

function base64Url(value: string | ArrayBuffer): string {
  return Buffer.from(typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)).toString('base64url')
}

/**
 * Sign `claims` with the current key as a compact JWS (RFC 7515): three
 * base64url parts, `header.claims.signature`. `type` goes into the header's
 * `typ`, so a statement cannot be passed off as another kind of token.
 */
export async function signWithCurrentKey(db: DbClient, type: string, claims: Record<string, unknown>): Promise<string> {
  const row = await currentKeyRow(db)
  if (row.key_fingerprint !== (await getMasterKeyFingerprint())) throw new SigningKeyUnreadableError()
  const d = await decryptSecret(await loadMasterKey(), { ciphertext: row.private_ciphertext, iv: row.private_iv })
  const key = await crypto.subtle.importKey('jwk', { ...publicKeyOf(row), d }, { name: 'Ed25519' }, false, ['sign'])
  const signed = `${base64Url(JSON.stringify({ alg: 'EdDSA', typ: type, kid: row.id }))}.${base64Url(JSON.stringify(claims))}`
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(signed))
  return `${signed}.${base64Url(signature)}`
}
