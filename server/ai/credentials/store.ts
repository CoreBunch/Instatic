/**
 * AI provider credential repository — CRUD over `ai_provider_credentials`.
 *
 * Owns:
 *   - All SQL touching the credentials table.
 *   - Encryption on write + decryption on read.
 *   - The boundary between DB row shape (Uint8Array bytea/blob) and the
 *     server-side `CredentialRecord` (typed bytes).
 *   - The wire-safe `CredentialView` projection — `toCredentialView()` is
 *     the ONLY way to expose a credential outside this module.
 *
 * Does NOT own:
 *   - HTTP semantics (handlers parse bodies + call these functions).
 *   - Capability gating (handlers call `requireCapability` first).
 *   - Cross-user reads (every query filters by `user_id` — defence in depth).
 *
 * Gated by `ai-credentials-never-leak.test.ts` (Phase 1).
 */

import { nanoid } from 'nanoid'
import type { DbClient } from '../../db/client'
import { isoDateOrNull } from '@core/utils/isoDate'
import {
  decryptSecret,
  encryptSecret,
  type EncryptedSecret,
} from '../../secrets/encryption'
import {
  getMasterKeyFingerprint,
  loadMasterKey,
  MasterKeyConfigurationError,
} from '../../secrets/masterKey'
import type {
  CreateCredentialInput,
  CredentialRecord,
  CredentialView,
  UpdateCredentialInput,
} from './types'
import type { AiAuthMode, AiProviderId } from '../runtime/types'
import type { AiResolvedCredential } from '../drivers/types'

// ---------------------------------------------------------------------------
// Row shape ↔ record shape
// ---------------------------------------------------------------------------

interface CredentialRow {
  id: string
  user_id: string
  provider_id: string
  auth_mode: string
  display_label: string
  ciphertext: Uint8Array | null
  iv: Uint8Array | null
  base_url: string | null
  key_fingerprint: string | null
  created_at: Date | string
  updated_at: Date | string
  last_used_at: Date | string | null
}

function rowToRecord(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    userId: row.user_id,
    providerId: row.provider_id as AiProviderId,
    authMode: row.auth_mode as AiAuthMode,
    displayLabel: row.display_label,
    ciphertext: row.ciphertext,
    iv: row.iv,
    baseUrl: row.base_url,
    keyFingerprint: row.key_fingerprint,
    createdAt: isoDateOrNull(row.created_at)!,
    updatedAt: isoDateOrNull(row.updated_at)!,
    lastUsedAt: isoDateOrNull(row.last_used_at),
  }
}

/**
 * Project a CredentialRecord to its wire-safe view. This function — and only
 * this function — is allowed to cross the HTTP boundary with credential
 * data. The `ai-credentials-never-leak.test.ts` gate scans handlers to
 * ensure no other shape escapes.
 */
export async function toCredentialView(
  record: CredentialRecord,
): Promise<CredentialView> {
  const currentFingerprint = record.keyFingerprint
    ? await getMasterKeyFingerprint()
    : null
  return {
    id: record.id,
    providerId: record.providerId,
    authMode: record.authMode,
    displayLabel: record.displayLabel,
    baseUrl: record.baseUrl,
    keyFingerprintCurrent:
      record.keyFingerprint === null
        ? true
        : record.keyFingerprint === currentFingerprint,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CredentialError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'CredentialError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * List every credential owned by `userId`, newest first. Returns records
 * (not views) — the handler projects to views via `toCredentialView()`.
 *
 * The query restricts `auth_mode` to the currently-supported set so a
 * stale dev row carrying a retired value never reaches the wire and
 * breaks the JSON-schema parse on the client.
 */
export async function listCredentialsForUser(
  db: DbClient,
  userId: string,
): Promise<CredentialRecord[]> {
  const { rows } = await db<CredentialRow>`
    select id, user_id, provider_id, auth_mode, display_label,
           ciphertext, iv, base_url, key_fingerprint,
           created_at, updated_at, last_used_at
    from ai_provider_credentials
    where user_id = ${userId}
      and auth_mode in ('apiKey', 'baseUrl')
    order by created_at desc
  `
  return rows.map(rowToRecord)
}

/**
 * Read a single credential, with the `user_id` predicate as a cross-user
 * guard. Returns null when the row doesn't exist OR belongs to another
 * user — handlers should treat both as 404.
 */
export async function readCredentialForUser(
  db: DbClient,
  userId: string,
  credentialId: string,
): Promise<CredentialRecord | null> {
  const { rows } = await db<CredentialRow>`
    select id, user_id, provider_id, auth_mode, display_label,
           ciphertext, iv, base_url, key_fingerprint,
           created_at, updated_at, last_used_at
    from ai_provider_credentials
    where id = ${credentialId} and user_id = ${userId}
    limit 1
  `
  return rows[0] ? rowToRecord(rows[0]) : null
}

/**
 * Decrypt a credential into a driver-callable `AiResolvedCredential`. The
 * returned object holds the plaintext key in memory for the duration of the
 * caller's frame — callers MUST scope it to a single driver invocation.
 *
 * Throws if:
 *   - The key's fingerprint doesn't match the live master key
 *     (rotation needed — UI shows "re-enter your key").
 *   - Decryption fails (tampering or corrupted ciphertext).
 *   - The auth_mode + shape are inconsistent (data corruption).
 */
export async function resolveCredentialForDriver(
  record: CredentialRecord,
): Promise<AiResolvedCredential> {
  const currentFingerprint = await getMasterKeyFingerprint()
  if (record.keyFingerprint && record.keyFingerprint !== currentFingerprint) {
    throw new CredentialError(
      `Credential ${record.id} was encrypted with a different master key. ` +
      `Re-enter the API key in /admin/ai/providers.`,
      409,
    )
  }

  let apiKey: string | null = null
  if (record.ciphertext && record.iv) {
    const masterKey = await loadMasterKey()
    apiKey = await decryptSecret(masterKey, {
      ciphertext: record.ciphertext,
      iv: record.iv,
    })
  }

  if (record.authMode === 'apiKey' && !apiKey) {
    throw new CredentialError(
      `Credential ${record.id} is marked auth_mode='apiKey' but has no ` +
      `stored key — data corruption. Re-enter the key in /admin/ai/providers.`,
      500,
    )
  }

  if (record.authMode === 'baseUrl' && !record.baseUrl) {
    throw new CredentialError(
      `Credential ${record.id} is marked auth_mode='baseUrl' but has no ` +
      `stored URL — data corruption. Re-enter the URL in /admin/ai/providers.`,
      500,
    )
  }

  return {
    id: record.id,
    providerId: record.providerId,
    authMode: record.authMode,
    apiKey,
    baseUrl: record.baseUrl,
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Insert a new credential row. Encrypts any recoverable secret material with
 * the live master key + stores the key fingerprint so the UI can later detect
 * rotation.
 *
 * Throws CredentialError on:
 *   - duplicate (user_id, provider_id, display_label) — surfaced as 409
 *   - missing key for 'apiKey' mode — surfaced as 400
 *   - missing url for 'baseUrl' mode — surfaced as 400
 */
export async function createCredentialForUser(
  db: DbClient,
  userId: string,
  input: CreateCredentialInput,
): Promise<CredentialRecord> {
  const id = nanoid()
  let encrypted: EncryptedSecret | null
  let fingerprint: string | null
  try {
    encrypted = await maybeEncryptForInput(input)
    fingerprint = encrypted ? await getMasterKeyFingerprint() : null
  } catch (err) {
    if (err instanceof MasterKeyConfigurationError) {
      throw credentialEncryptionConfigurationError(err)
    }
    throw err
  }
  const baseUrl =
    input.authMode === 'baseUrl' ? input.baseUrl : null

  try {
    const { rows } = await db<CredentialRow>`
      insert into ai_provider_credentials (
        id, user_id, provider_id, auth_mode, display_label,
        ciphertext, iv, base_url, key_fingerprint
      )
      values (
        ${id}, ${userId}, ${input.providerId}, ${input.authMode}, ${input.displayLabel},
        ${encrypted?.ciphertext ?? null},
        ${encrypted?.iv ?? null},
        ${baseUrl},
        ${fingerprint}
      )
      returning id, user_id, provider_id, auth_mode, display_label,
                ciphertext, iv, base_url, key_fingerprint,
                created_at, updated_at, last_used_at
    `
    return rowToRecord(rows[0]!)
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CredentialError(
        `A credential named "${input.displayLabel}" already exists for this provider.`,
        409,
      )
    }
    throw err
  }
}

async function maybeEncryptForInput(
  input: CreateCredentialInput,
): Promise<EncryptedSecret | null> {
  if (input.authMode === 'apiKey') {
    return encryptKey(input.apiKey)
  }
  // baseUrl mode: API key is optional (bearer-protected proxies)
  if (input.apiKey && input.apiKey.length > 0) return encryptKey(input.apiKey)
  return null
}

async function encryptKey(plaintext: string): Promise<EncryptedSecret> {
  const masterKey = await loadMasterKey()
  return encryptSecret(masterKey, plaintext)
}

/**
 * Patch a credential row. Pass only the fields to update. Auth mode is NOT
 * patchable — to switch modes the caller deletes + creates instead. Returns
 * the updated record, or null if the row doesn't exist / belongs to a
 * different user.
 */
export async function updateCredentialForUser(
  db: DbClient,
  userId: string,
  credentialId: string,
  patch: UpdateCredentialInput,
): Promise<CredentialRecord | null> {
  const existing = await readCredentialForUser(db, userId, credentialId)
  if (!existing) return null

  const nextLabel = patch.displayLabel ?? existing.displayLabel
  const nextBaseUrl =
    patch.baseUrl !== undefined ? patch.baseUrl : existing.baseUrl

  let nextCiphertext = existing.ciphertext
  let nextIv = existing.iv
  let nextFingerprint = existing.keyFingerprint
  if (patch.apiKey !== undefined) {
    if (patch.apiKey.length === 0 && existing.authMode === 'apiKey') {
      throw new CredentialError(
        'API key cannot be empty for apiKey-mode credentials.',
        400,
      )
    }
    if (patch.apiKey.length === 0) {
      // baseUrl mode clearing optional bearer
      nextCiphertext = null
      nextIv = null
      nextFingerprint = null
    } else {
      try {
        const encrypted = await encryptKey(patch.apiKey)
        nextCiphertext = encrypted.ciphertext
        nextIv = encrypted.iv
        nextFingerprint = await getMasterKeyFingerprint()
      } catch (err) {
        if (err instanceof MasterKeyConfigurationError) {
          throw credentialEncryptionConfigurationError(err)
        }
        throw err
      }
    }
  }

  try {
    const { rows } = await db<CredentialRow>`
      update ai_provider_credentials
      set display_label = ${nextLabel},
          ciphertext = ${nextCiphertext},
          iv = ${nextIv},
          base_url = ${nextBaseUrl},
          key_fingerprint = ${nextFingerprint},
          updated_at = current_timestamp
      where id = ${credentialId} and user_id = ${userId}
      returning id, user_id, provider_id, auth_mode, display_label,
                ciphertext, iv, base_url, key_fingerprint,
                created_at, updated_at, last_used_at
    `
    return rows[0] ? rowToRecord(rows[0]) : null
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CredentialError(
        `A credential named "${nextLabel}" already exists for this provider.`,
        409,
      )
    }
    throw err
  }
}

/**
 * Hard-delete a credential. Rejected at the DB layer when the row is the
 * current default for any scope (FK `on delete restrict` on `ai_defaults`).
 *
 * Returns true when a row was deleted, false otherwise (404).
 */
export async function deleteCredentialForUser(
  db: DbClient,
  userId: string,
  credentialId: string,
): Promise<boolean> {
  try {
    const result = await db`
      delete from ai_provider_credentials
      where id = ${credentialId} and user_id = ${userId}
    `
    return result.rowCount > 0
  } catch (err) {
    if (isFkViolation(err)) {
      throw new CredentialError(
        'This credential is currently set as a default — change the default in /admin/ai/defaults before deleting.',
        409,
      )
    }
    throw err
  }
}

/**
 * Touch `last_used_at`. Called by the chat handler after a successful
 * stream so the UI can show "last used 5 minutes ago" per row.
 *
 * Best-effort: no error if the row vanishes mid-stream (cleanup race).
 */
export async function touchCredentialLastUsed(
  db: DbClient,
  credentialId: string,
): Promise<void> {
  await db`
    update ai_provider_credentials
    set last_used_at = current_timestamp
    where id = ${credentialId}
  `
}

// ---------------------------------------------------------------------------
// Internals — error classification
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  // PG sqlstate 23505 + SQLite "UNIQUE constraint failed". Match on message
  // text to stay dialect-agnostic — repositories shouldn't import driver
  // error classes.
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return msg.includes('unique') || msg.includes('23505') || msg.includes('duplicate')
}

function isFkViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return msg.includes('foreign key') || msg.includes('23503') || msg.includes('fk_')
}

function credentialEncryptionConfigurationError(
  err: MasterKeyConfigurationError,
): CredentialError {
  return new CredentialError(
    `AI credential encryption is not configured: ${err.message.replace('[secrets/masterKey] ', '')}`,
    500,
  )
}
