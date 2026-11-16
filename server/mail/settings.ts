/**
 * The site's one outgoing SMTP account — CRUD over the single `mail_settings`
 * row, with the password encrypted at rest under the master key.
 *
 * `toMailAccountView` is the only projection that leaves the server; it never
 * carries the password. `resolveMailAccount` is the only function that
 * decrypts it, for the transport's single use.
 */
import type { DbClient } from '../db/client'
import { isoDate, nowIso } from '@core/utils/isoDate'
import type { MailAccount, MailSettingsInput } from '@core/mail'
import { decryptSecret, encryptSecret } from '../secrets/encryption'
import { getMasterKeyFingerprint, loadMasterKey } from '../secrets/masterKey'

const SETTINGS_ROW_ID = 'default'

interface MailSettingsRow {
  host: string
  port: number
  username: string
  password_ciphertext: Uint8Array | null
  password_iv: Uint8Array | null
  key_fingerprint: string | null
  from_address: string
  from_name: string
  updated_at: Date | string
}

/** A stored account with its password decrypted, for one send. */
export interface ResolvedMailAccount {
  host: string
  port: number
  username: string
  password: string
  fromAddress: string
  fromName: string
}

/** The stored password cannot be read with the current server secret key. */
export class MailPasswordUnreadableError extends Error {
  constructor(options?: ErrorOptions) {
    super('The saved SMTP password can no longer be read. Enter it again in Settings → Email.', options)
    this.name = 'MailPasswordUnreadableError'
  }
}

async function readRow(db: DbClient): Promise<MailSettingsRow | null> {
  const { rows } = await db<MailSettingsRow>`
    select host, port, username, password_ciphertext, password_iv, key_fingerprint,
           from_address, from_name, updated_at
      from mail_settings
     where id = ${SETTINGS_ROW_ID}
  `
  return rows[0] ?? null
}

export async function getMailAccountView(db: DbClient): Promise<MailAccount | null> {
  const row = await readRow(db)
  if (!row) return null
  const hasPassword = row.password_ciphertext !== null && row.password_iv !== null
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    hasPassword,
    passwordNeedsReentry:
      hasPassword && row.key_fingerprint !== (await getMasterKeyFingerprint()),
    fromAddress: row.from_address,
    fromName: row.from_name,
    updatedAt: isoDate(row.updated_at),
  }
}

export async function resolveMailAccount(db: DbClient): Promise<ResolvedMailAccount | null> {
  const row = await readRow(db)
  if (!row) return null
  let password = ''
  if (row.password_ciphertext && row.password_iv) {
    if (row.key_fingerprint !== (await getMasterKeyFingerprint())) {
      throw new MailPasswordUnreadableError()
    }
    try {
      password = await decryptSecret(await loadMasterKey(), {
        ciphertext: row.password_ciphertext,
        iv: row.password_iv,
      })
    } catch (err) {
      throw new MailPasswordUnreadableError({ cause: err })
    }
  }
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    password,
    fromAddress: row.from_address,
    fromName: row.from_name,
  }
}

/**
 * Save the account. `input.password === undefined` keeps the stored password
 * (the form never receives it back, so an untouched field must not wipe it);
 * an empty string clears it.
 */
export async function saveMailSettings(
  db: DbClient,
  input: MailSettingsInput,
  actorUserId: string,
): Promise<void> {
  const host = input.host.toLowerCase()
  const now = nowIso()

  if (input.password === undefined) {
    const existing = await readRow(db)
    if (existing) {
      await db`
        update mail_settings
           set host = ${host}, port = ${input.port}, username = ${input.username},
               from_address = ${input.fromAddress}, from_name = ${input.fromName},
               updated_by_user_id = ${actorUserId}, updated_at = ${now}
         where id = ${SETTINGS_ROW_ID}
      `
      return
    }
  }

  const encrypted = input.password
    ? await encryptSecret(await loadMasterKey(), input.password)
    : null
  const fingerprint = encrypted ? await getMasterKeyFingerprint() : null
  await db`
    insert into mail_settings (
      id, host, port, username, password_ciphertext, password_iv, key_fingerprint,
      from_address, from_name, updated_by_user_id, updated_at
    ) values (
      ${SETTINGS_ROW_ID}, ${host}, ${input.port}, ${input.username},
      ${encrypted?.ciphertext ?? null}, ${encrypted?.iv ?? null}, ${fingerprint},
      ${input.fromAddress}, ${input.fromName}, ${actorUserId}, ${now}
    )
    on conflict (id) do update set
      host = excluded.host,
      port = excluded.port,
      username = excluded.username,
      password_ciphertext = excluded.password_ciphertext,
      password_iv = excluded.password_iv,
      key_fingerprint = excluded.key_fingerprint,
      from_address = excluded.from_address,
      from_name = excluded.from_name,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = excluded.updated_at
  `
}

export async function deleteMailSettings(db: DbClient): Promise<void> {
  await db`delete from mail_settings where id = ${SETTINGS_ROW_ID}`
}
