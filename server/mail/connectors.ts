/**
 * Mail connectors — the accounts the server can send through
 * (`mail_connectors`). Each has a kind (SMTP, Amazon SES), a public config
 * and one secret, encrypted at rest under the master key.
 *
 * `toView` is the only projection that leaves the server and never carries
 * the secret. `resolveConnector` is the only function that decrypts it, for
 * a single send.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import {
  SesConnectorConfigSchema,
  SmtpConnectorConfigSchema,
  type MailConnector,
  type MailConnectorInput,
  type SesConnectorConfig,
  type SmtpConnectorConfig,
} from '@core/mail'
import { isoDate, isoDateOrNull, nowIso } from '@core/utils/isoDate'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import { decryptSecret, encryptSecret } from '../secrets/encryption'
import { getMasterKeyFingerprint, loadMasterKey } from '../secrets/masterKey'

interface ConnectorRow {
  id: string
  kind: string
  label: string
  config_json: unknown
  secret_ciphertext: Uint8Array | null
  secret_iv: Uint8Array | null
  key_fingerprint: string | null
  last_used_at: Date | string | null
  last_error: string | null
  created_at: Date | string
}

const COLUMNS = `id, kind, label, config_json, secret_ciphertext, secret_iv, key_fingerprint,
  last_used_at, last_error, created_at`

/** A connector with its secret decrypted, for one send. */
export type ResolvedConnector =
  | { id: string; label: string; kind: 'smtp'; config: SmtpConnectorConfig; secret: string }
  | { id: string; label: string; kind: 'ses'; config: SesConnectorConfig; secret: string }

/** The stored secret cannot be read with the current server secret key. */
export class MailSecretUnreadableError extends Error {
  constructor(label: string, options?: ErrorOptions) {
    super(`The saved secret of the "${label}" connector can no longer be read. Enter it again.`, options)
    this.name = 'MailSecretUnreadableError'
  }
}

type TypedConfig =
  | { kind: 'smtp'; config: SmtpConnectorConfig }
  | { kind: 'ses'; config: SesConnectorConfig }

/** Validate a stored config against its kind. A row that fails is skipped, not trusted. */
function readConfig(row: ConnectorRow): TypedConfig | null {
  if (row.kind === 'smtp') {
    const parsed = safeParseValue(SmtpConnectorConfigSchema, row.config_json)
    return parsed.ok ? { kind: 'smtp', config: parsed.value } : null
  }
  if (row.kind === 'ses') {
    const parsed = safeParseValue(SesConnectorConfigSchema, row.config_json)
    return parsed.ok ? { kind: 'ses', config: parsed.value } : null
  }
  return null
}

async function toView(row: ConnectorRow, fingerprint: string): Promise<MailConnector | null> {
  const typed = readConfig(row)
  if (!typed) return null
  const hasSecret = row.secret_ciphertext !== null && row.secret_iv !== null
  return {
    ...typed,
    id: row.id,
    label: row.label,
    hasSecret,
    secretNeedsReentry: hasSecret && row.key_fingerprint !== fingerprint,
    lastUsedAt: isoDateOrNull(row.last_used_at),
    lastError: row.last_error,
    createdAt: isoDate(row.created_at),
  }
}

function placeholder(db: DbClient, index: number): string {
  return db.dialect === 'postgres' ? `$${index}` : '?'
}

export async function listMailConnectors(db: DbClient): Promise<MailConnector[]> {
  const { rows } = await db.unsafe<ConnectorRow>(
    `select ${COLUMNS} from mail_connectors order by created_at asc, id asc`,
  )
  const fingerprint = await getMasterKeyFingerprint()
  const views = await Promise.all(rows.map((row) => toView(row, fingerprint)))
  return views.filter((view): view is MailConnector => view !== null)
}

async function readRow(db: DbClient, id: string): Promise<ConnectorRow | null> {
  const { rows } = await db.unsafe<ConnectorRow>(
    `select ${COLUMNS} from mail_connectors where id = ${placeholder(db, 1)}`,
    [id],
  )
  return rows[0] ?? null
}

export async function getMailConnector(db: DbClient, id: string): Promise<MailConnector | null> {
  const row = await readRow(db, id)
  return row ? toView(row, await getMasterKeyFingerprint()) : null
}

async function encryptedSecret(secret: string): Promise<{
  ciphertext: Uint8Array | null
  iv: Uint8Array | null
  fingerprint: string | null
}> {
  if (secret === '') return { ciphertext: null, iv: null, fingerprint: null }
  const encrypted = await encryptSecret(await loadMasterKey(), secret)
  return { ciphertext: encrypted.ciphertext, iv: encrypted.iv, fingerprint: await getMasterKeyFingerprint() }
}

export async function createMailConnector(
  db: DbClient,
  input: MailConnectorInput,
  actorUserId: string,
): Promise<MailConnector> {
  const id = nanoid()
  const now = nowIso()
  const secret = await encryptedSecret(input.secret)
  const config = input.kind === 'smtp' ? { ...input.config, host: input.config.host.toLowerCase() } : input.config
  await db`
    insert into mail_connectors (
      id, kind, label, config_json, secret_ciphertext, secret_iv, key_fingerprint,
      created_by_user_id, created_at, updated_at
    ) values (
      ${id}, ${input.kind}, ${input.label.trim()}, ${config}, ${secret.ciphertext}, ${secret.iv},
      ${secret.fingerprint}, ${actorUserId}, ${now}, ${now}
    )
  `
  const created = await getMailConnector(db, id)
  if (!created) throw new Error('mail connector could not be re-read after insert')
  return created
}

/** Replace a connector's secret (re-entry after a key change, or a rotation). */
export async function setMailConnectorSecret(db: DbClient, id: string, secret: string): Promise<boolean> {
  const encrypted = await encryptedSecret(secret)
  const { rows } = await db<{ id: string }>`
    update mail_connectors
       set secret_ciphertext = ${encrypted.ciphertext}, secret_iv = ${encrypted.iv},
           key_fingerprint = ${encrypted.fingerprint}, last_error = null, updated_at = ${nowIso()}
     where id = ${id}
    returning id
  `
  return rows.length > 0
}

export async function deleteMailConnector(db: DbClient, id: string): Promise<boolean> {
  const { rows } = await db<{ id: string }>`delete from mail_connectors where id = ${id} returning id`
  return rows.length > 0
}

export async function resolveConnector(db: DbClient, id: string): Promise<ResolvedConnector | null> {
  const row = await readRow(db, id)
  if (!row) return null
  const typed = readConfig(row)
  if (!typed) return null
  let secret = ''
  if (row.secret_ciphertext && row.secret_iv) {
    if (row.key_fingerprint !== (await getMasterKeyFingerprint())) throw new MailSecretUnreadableError(row.label)
    try {
      secret = await decryptSecret(await loadMasterKey(), { ciphertext: row.secret_ciphertext, iv: row.secret_iv })
    } catch (err) {
      throw new MailSecretUnreadableError(row.label, { cause: err })
    }
  }
  return { ...typed, id: row.id, label: row.label, secret }
}

/** Record how the last use of a connector went. */
export async function noteConnectorUse(db: DbClient, id: string, error: string | null): Promise<void> {
  const now = nowIso()
  await db`
    update mail_connectors set last_used_at = ${now}, last_error = ${error}, updated_at = ${now}
     where id = ${id}
  `
}
