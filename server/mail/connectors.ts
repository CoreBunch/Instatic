/**
 * Mail connectors — the accounts the server can send through
 * (`mail_connectors`). Each has a kind (SMTP, Amazon SES, or a provider's
 * API reached with one key), a public config
 * and one secret, encrypted at rest under the master key.
 *
 * `toView` is the only projection that leaves the server and never carries
 * the secret. `resolveConnector` is the only function that decrypts it, for
 * a single send.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import {
  MAIL_CONNECTOR_CONFIG_SCHEMAS,
  MAIL_CONNECTOR_KINDS,
  type KeyOnlyConnectorConfig,
  type MailConnector,
  type MailConnectorInput,
  type MailConnectorKind,
  type MailgunConnectorConfig,
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
  delivery_paused_at: Date | string | null
  created_at: Date | string
}

const COLUMNS = `id, kind, label, config_json, secret_ciphertext, secret_iv, key_fingerprint,
  last_used_at, last_error, delivery_paused_at, created_at`

/** A connector with its secret decrypted, for one send. */
export type ResolvedConnector = TypedConfig & { id: string; label: string; secret: string }

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
  | { kind: 'resend' | 'postmark' | 'brevo'; config: KeyOnlyConnectorConfig }
  | { kind: 'mailgun'; config: MailgunConnectorConfig }

function isConnectorKind(kind: string): kind is MailConnectorKind {
  return (MAIL_CONNECTOR_KINDS as readonly string[]).includes(kind)
}

/** Validate a stored config against its kind. A row that fails is skipped, not trusted. */
function readConfig(row: ConnectorRow): TypedConfig | null {
  if (!isConnectorKind(row.kind)) return null
  const parsed = safeParseValue(MAIL_CONNECTOR_CONFIG_SCHEMAS[row.kind], row.config_json)
  // The schema was picked by the kind, so the pair is one of the union's members.
  return parsed.ok ? ({ kind: row.kind, config: parsed.value } as TypedConfig) : null
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
    deliveryPaused: row.delivery_paused_at !== null,
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
  const config = input.kind === 'smtp'
    ? { ...input.config, host: input.config.host.toLowerCase() }
    : input.kind === 'mailgun'
      ? { ...input.config, domain: input.config.domain.toLowerCase() }
      : input.config
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
           key_fingerprint = ${encrypted.fingerprint}, last_error = null, delivery_paused_at = null,
           updated_at = ${nowIso()}
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

/**
 * Record how the last use of a connector went. A use that worked also lifts
 * a pause: the account is evidently accepted again.
 */
export async function noteConnectorUse(db: DbClient, id: string, error: string | null): Promise<void> {
  const now = nowIso()
  if (error === null) {
    await db`
      update mail_connectors
         set last_used_at = ${now}, last_error = null, delivery_paused_at = null, updated_at = ${now}
       where id = ${id}
    `
    return
  }
  await db`
    update mail_connectors set last_used_at = ${now}, last_error = ${error}, updated_at = ${now}
     where id = ${id}
  `
}

/**
 * Stop sending queued email through a connector that refuses the account
 * itself (a wrong key or password, a secret that cannot be read). A stream
 * of failed logins can get an account locked, so the queue is held. It is a
 * circuit breaker, not a switch someone has to remember to flip back:
 * `delivery_paused_at` is the time of the last refusal, and every
 * `CONNECTOR_PROBE_INTERVAL_MS` one email is let through as a probe
 * (`takeConnectorProbe`). A send that works, the probe's or the connector
 * test's, lifts the pause (`noteConnectorUse`); so does a new secret.
 */
export async function pauseConnectorDelivery(db: DbClient, id: string, now: number = Date.now()): Promise<void> {
  await db`update mail_connectors set delivery_paused_at = ${new Date(now).toISOString()} where id = ${id}`
}

/** How often a paused connector is tried with one email. */
export const CONNECTOR_PROBE_INTERVAL_MS = 2 * 60 * 1000

/** Why queued email is held, when the connector is paused. */
export async function connectorPauseReason(db: DbClient, id: string): Promise<string | null> {
  const { rows } = await db<{ delivery_paused_at: Date | string | null; last_error: string | null }>`
    select delivery_paused_at, last_error from mail_connectors where id = ${id}
  `
  const row = rows[0]
  if (!row || row.delivery_paused_at === null) return null
  return row.last_error ?? 'The connector refused the account.'
}

/**
 * Whether queued email may go through this connector now: `open` when it is
 * not paused, `probe` when it is paused and this caller has just taken the
 * one probe that is due, `held` otherwise. Taking the probe is one
 * conditional update, so of several workers exactly one gets it.
 */
export async function takeConnectorProbe(db: DbClient, id: string, now: number): Promise<'open' | 'probe' | 'held'> {
  if ((await connectorPauseReason(db, id)) === null) return 'open'
  const taken = await db`
    update mail_connectors set delivery_paused_at = ${new Date(now).toISOString()}
     where id = ${id} and delivery_paused_at is not null
       and delivery_paused_at <= ${new Date(now - CONNECTOR_PROBE_INTERVAL_MS).toISOString()}
  `
  return taken.rowCount > 0 ? 'probe' : 'held'
}
