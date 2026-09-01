import type { DbClient } from '../db/client'
import { decryptSecret, encryptSecret } from '../secrets/encryption'
import {
  getMasterKeyFingerprint,
  loadMasterKey,
  MasterKeyConfigurationError,
} from '../secrets/masterKey'
import type {
  SaveStagingEnvironment,
  StagingEnvironment,
  StagingSyncStatus,
} from '@core/staging'

interface StagingEnvironmentRow {
  origin: string
  token_ciphertext: Uint8Array
  token_iv: Uint8Array
  key_fingerprint: string
  table_ids_json: string[]
  include_site: boolean | number
  last_sync_at: string | null
  last_sync_status: StagingSyncStatus | null
  last_sync_error: string | null
}

export interface ResolvedStagingEnvironment {
  origin: string
  token: string
  tableIds: string[]
  includeSite: boolean
}

export class StagingEnvironmentError extends Error {
  readonly status: number

  constructor(message: string, status = 400, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StagingEnvironmentError'
    this.status = status
  }
}

async function readRow(db: DbClient): Promise<StagingEnvironmentRow | null> {
  const { rows } = await db<StagingEnvironmentRow>`
    select origin, token_ciphertext, token_iv, key_fingerprint, table_ids_json,
           include_site, last_sync_at, last_sync_status, last_sync_error
    from staging_environment
    where id = 1
  `
  return rows[0] ?? null
}

export async function getStagingEnvironment(db: DbClient): Promise<StagingEnvironment> {
  const row = await readRow(db)
  if (!row) {
    return {
      configured: false,
      origin: null,
      hasToken: false,
      keyFingerprintCurrent: true,
      tableIds: [],
      includeSite: true,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    }
  }

  let fingerprint: string | null = null
  try {
    fingerprint = await getMasterKeyFingerprint()
  } catch (err) {
    console.error('[staging] master key unavailable while reading configuration:', err)
  }

  return {
    configured: true,
    origin: row.origin,
    hasToken: true,
    keyFingerprintCurrent: row.key_fingerprint === fingerprint,
    tableIds: row.table_ids_json,
    includeSite: Boolean(row.include_site),
    lastSyncAt: row.last_sync_at,
    lastSyncStatus: row.last_sync_status,
    lastSyncError: row.last_sync_error,
  }
}

export async function saveStagingEnvironment(
  db: DbClient,
  input: SaveStagingEnvironment,
  userId: string,
): Promise<StagingEnvironment> {
  const existing = await readRow(db)
  let ciphertext = existing?.token_ciphertext
  let iv = existing?.token_iv
  let fingerprint = existing?.key_fingerprint

  if (input.token !== undefined) {
    try {
      const masterKey = await loadMasterKey()
      const encrypted = await encryptSecret(masterKey, input.token)
      ciphertext = encrypted.ciphertext
      iv = encrypted.iv
      fingerprint = await getMasterKeyFingerprint()
    } catch (err) {
      if (err instanceof MasterKeyConfigurationError) {
        throw new StagingEnvironmentError(
          `Staging token encryption is not configured: ${err.message.replace('[secrets/masterKey] ', '')}`,
          500,
          { cause: err },
        )
      }
      throw err
    }
  }

  if (!ciphertext || !iv || !fingerprint) {
    throw new StagingEnvironmentError('A staging sync token is required for initial setup.')
  }

  await db`
    insert into staging_environment (
      id, origin, token_ciphertext, token_iv, key_fingerprint,
      table_ids_json, include_site, created_by_user_id
    ) values (
      1, ${input.origin}, ${ciphertext}, ${iv}, ${fingerprint},
      ${input.tableIds}, ${input.includeSite}, ${userId}
    )
    on conflict (id) do update
      set origin = excluded.origin,
          token_ciphertext = excluded.token_ciphertext,
          token_iv = excluded.token_iv,
          key_fingerprint = excluded.key_fingerprint,
          table_ids_json = excluded.table_ids_json,
          include_site = excluded.include_site,
          updated_at = current_timestamp
  `

  return getStagingEnvironment(db)
}

export async function resolveStagingEnvironment(
  db: DbClient,
): Promise<ResolvedStagingEnvironment> {
  const row = await readRow(db)
  if (!row) throw new StagingEnvironmentError('Staging is not configured.', 404)

  const fingerprint = await getMasterKeyFingerprint()
  if (row.key_fingerprint !== fingerprint) {
    throw new StagingEnvironmentError(
      'The staging token was encrypted with a different master key. Re-enter it before syncing.',
      409,
    )
  }

  try {
    const token = await decryptSecret(await loadMasterKey(), {
      ciphertext: row.token_ciphertext,
      iv: row.token_iv,
    })
    return {
      origin: row.origin,
      token,
      tableIds: row.table_ids_json,
      includeSite: Boolean(row.include_site),
    }
  } catch (err) {
    throw new StagingEnvironmentError('The staging token could not be decrypted. Re-enter it.', 409, {
      cause: err,
    })
  }
}

export async function recordStagingSync(
  db: DbClient,
  status: StagingSyncStatus,
  error: string | null,
): Promise<void> {
  await db`
    update staging_environment
    set last_sync_at = current_timestamp,
        last_sync_status = ${status},
        last_sync_error = ${error},
        updated_at = current_timestamp
    where id = 1
  `
}

export async function deleteStagingEnvironment(db: DbClient): Promise<boolean> {
  const result = await db`delete from staging_environment where id = 1`
  return result.rowCount > 0
}
