/**
 * The outgoing mail queue (`mail_queue`): emails accepted for delivery that
 * have not left yet.
 *
 * A row holds the template key, the recipient and the values to fill the
 * template with. The values are encrypted with the master key, because they
 * carry live sign-in and reset links, and the row is deleted the moment the
 * email is sent or given up on.
 *
 * `lane` orders the queue: the core's own mail (0) always goes before a
 * plugin's (1), so a plugin's backlog can never hold up a sign-in link.
 * Within a lane, an email that has not been tried yet goes before one that is
 * waiting for a retry: a fresh sign-in link is never behind a stack of
 * retries.
 *
 * A row is claimed with one conditional update. That claim is the only
 * coordination between workers: any number of server instances may drain at
 * once and no email is taken twice.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { Type, type Static } from '@sinclair/typebox'
import { safeParseJson } from '@core/utils/jsonValidate'
import { isoDate, nowIso } from '@core/utils/isoDate'
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../secrets/encryption'
import { loadMasterKey } from '../secrets/masterKey'
import { CORE_MAIL_SOURCE } from './activity'
import { releaseBacklogSlot } from './limits'

const QueuedPayloadSchema = Type.Object({
  variables: Type.Record(Type.String(), Type.String()),
})
type QueuedPayload = Static<typeof QueuedPayloadSchema>

/**
 * A claim older than this belonged to a worker that died mid-send. A
 * hand-over is cut off by its driver after ten seconds, so two minutes is
 * many times the longest a live claim can last.
 *
 * The claim time is written by one instance's clock and judged by
 * another's, so the rule tolerates the instances' clocks differing by up to
 * about 110 seconds. Beyond that a live claim could be taken over, which
 * costs one duplicate email, never a lost one. Hosts kept on time by NTP
 * are within milliseconds.
 */
const STALE_CLAIM_MS = 2 * 60 * 1000

/**
 * An email is not sent with less than this much of its life left: a sign-in
 * link that stops working a few seconds after it arrives is no better than
 * one that arrives too late.
 */
export const DELIVERY_MARGIN_MS = 60 * 1000

interface QueueRow {
  id: string
  outbox_id: string
  kind: string
  to_address: string
  source: string
  reference: string | null
  member_id: string | null
  payload_ciphertext: Uint8Array
  payload_iv: Uint8Array
  attempts: number
  last_error: string | null
  deliver_before: Date | string
  install_id: string | null
  suspect_at: Date | string | null
}

export interface QueuedMail {
  id: string
  /** The activity-log row that follows this email. */
  outboxId: string
  /** The template key. */
  kind: string
  to: string
  /** `core`, or the id of the plugin that asked for the email. */
  source: string
  /** The sender's own name for this email, handed back with the outcome. */
  reference: string | null
  /** Set when the sender named a site member, not an address. */
  memberId: string | null
  attempts: number
  /** Why the last attempt did not deliver it, if there was one. */
  lastError: string | null
  /** After this moment the email is not sent any more. Milliseconds since the epoch. */
  deliverBefore: number
  /** The install of the sending plugin that queued it (see `ensurePluginInstallId`). Null for the core's email. */
  installId: string | null
  /** An earlier try got an ambiguous refusal (see `markQueuedMailSuspect`). */
  suspect: boolean
  payload: EncryptedSecret
}

function toQueuedMail(row: QueueRow): QueuedMail {
  return {
    id: row.id,
    outboxId: row.outbox_id,
    kind: row.kind,
    to: row.to_address,
    source: row.source,
    reference: row.reference,
    memberId: row.member_id,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    deliverBefore: Date.parse(isoDate(row.deliver_before)),
    installId: row.install_id,
    suspect: row.suspect_at !== null,
    payload: { ciphertext: row.payload_ciphertext, iv: row.payload_iv },
  }
}

/**
 * Encrypt the values of an email that is about to be queued. Done before the
 * transaction that queues it opens: loading the key and encrypting can fail,
 * and nothing that can fail for its own reasons belongs inside a transaction
 * on SQLite's one shared connection.
 */
export async function encryptQueuedVariables(variables: Record<string, string>): Promise<EncryptedSecret> {
  const payload: QueuedPayload = { variables }
  return encryptSecret(await loadMasterKey(), JSON.stringify(payload))
}

export interface EnqueueMailInput {
  outboxId: string
  kind: string
  to: string
  payload: EncryptedSecret
  /** After this moment the email is not sent any more. Milliseconds since the epoch. */
  deliverBefore: number
  source?: string
  reference?: string
  /** The site member the email is for, when the sender named one rather than an address. */
  memberId?: string
  /** The sending plugin's install. */
  installId?: string
}

export async function enqueueMail(db: DbClient, input: EnqueueMailInput): Promise<void> {
  const source = input.source ?? CORE_MAIL_SOURCE
  const now = nowIso()
  await db`
    insert into mail_queue (
      id, outbox_id, kind, to_address, source, reference, member_id, install_id, lane,
      payload_ciphertext, payload_iv, attempts, next_attempt_at, deliver_before, created_at
    ) values (
      ${nanoid()}, ${input.outboxId}, ${input.kind}, ${input.to}, ${source}, ${input.reference ?? null},
      ${input.memberId ?? null}, ${input.installId ?? null}, ${source === CORE_MAIL_SOURCE ? 0 : 1},
      ${input.payload.ciphertext}, ${input.payload.iv}, 0, ${now},
      ${new Date(input.deliverBefore).toISOString()}, ${now}
    )
  `
}

/** The stored values cannot be decrypted: the server's secret key changed while the email waited. */
export class QueuedMailUnreadableError extends Error {
  constructor(options?: ErrorOptions) {
    super('The queued email can no longer be read with the current server secret key.', options)
    this.name = 'QueuedMailUnreadableError'
  }
}

/**
 * The values a queued email was accepted with. Throws
 * `QueuedMailUnreadableError` only when decryption fails; anything else (a
 * key that cannot be loaded right now) is the caller's to retry.
 */
export async function readQueuedVariables(mail: QueuedMail): Promise<Record<string, string>> {
  const key = await loadMasterKey()
  let plaintext: string
  try {
    plaintext = await decryptSecret(key, mail.payload)
  } catch (err) {
    throw new QueuedMailUnreadableError({ cause: err })
  }
  const parsed = safeParseJson(plaintext, QueuedPayloadSchema)
  if (!parsed.ok) throw parsed.error
  return parsed.value.variables
}

/**
 * Hand claims left by a worker that died back to the queue. An email whose
 * worker died after the provider accepted it, but before the row was
 * deleted, is sent a second time: delivery is at least once.
 */
export async function releaseStaleMailClaims(db: DbClient, now: number): Promise<void> {
  await db`
    update mail_queue set claimed_at = null
     where claimed_at is not null and claimed_at < ${new Date(now - STALE_CLAIM_MS).toISOString()}
  `
}

const QUEUE_COLUMNS = `id, outbox_id, kind, to_address, source, reference, member_id,
  payload_ciphertext, payload_iv, attempts, last_error, deliver_before, install_id, suspect_at`

function placeholder(db: DbClient, index: number): string {
  return db.dialect === 'postgres' ? `$${index}` : '?'
}

/** Claim one row, or learn that another worker took it first. */
async function claim(db: DbClient, row: QueueRow, at: string): Promise<QueuedMail | null> {
  const claimed = await db`
    update mail_queue set claimed_at = ${at} where id = ${row.id} and claimed_at is null
  `
  return claimed.rowCount > 0 ? toQueuedMail(row) : null
}

/** Whether any email is due and can still be delivered. */
export async function hasDueMail(db: DbClient, now: number): Promise<boolean> {
  const { rows } = await db<{ id: string }>`
    select id from mail_queue
     where claimed_at is null and accepted_at is null
       and next_attempt_at <= ${new Date(now).toISOString()}
       and deliver_before > ${new Date(now + DELIVERY_MARGIN_MS).toISOString()}
     limit 1
  `
  return rows.length > 0
}

/**
 * Note that the provider refused this email in a way that may be about its
 * recipient or about the account (an ambiguous refusal). Such an email is
 * the last choice for a probe of a paused connector: it would only repeat
 * the answer that paused it.
 */
export async function markQueuedMailSuspect(db: DbClient, id: string, now: number): Promise<void> {
  await db`update mail_queue set suspect_at = ${new Date(now).toISOString()} where id = ${id}`
}

/**
 * Claim the email to try a paused connector with, leaving out those already
 * tried in this probe (`tried`). The best probe is the one most likely to
 * say something about the connector and most worth sending: an email with
 * no ambiguous refusal behind it, the core's before a plugin's, the newest
 * first (a sign-in link someone is waiting for now). Only when every due
 * email has such a refusal behind it is the newest of those used.
 */
export async function claimProbeMail(db: DbClient, now: number, tried: readonly string[]): Promise<QueuedMail | null> {
  const at = new Date(now).toISOString()
  const usefulUntil = new Date(now + DELIVERY_MARGIN_MS).toISOString()
  for (;;) {
    const { rows } = await db.unsafe<QueueRow>(
      `select ${QUEUE_COLUMNS}
         from mail_queue
        where claimed_at is null and accepted_at is null
          and next_attempt_at <= ${placeholder(db, 1)} and deliver_before > ${placeholder(db, 2)}
        order by case when suspect_at is null then 0 else 1 end asc, lane asc, outbox_id desc
        limit ${tried.length + 1}`,
      [at, usefulUntil],
    )
    const row = rows.find((candidate) => !tried.includes(candidate.id))
    if (!row) return null
    const mail = await claim(db, row, at)
    if (mail) return mail
  }
}

/**
 * Claim the next email that is due and can still be delivered, or null when
 * none is. Two workers can never both take a row.
 */
export async function claimNextDueMail(db: DbClient, now: number): Promise<QueuedMail | null> {
  const at = new Date(now).toISOString()
  const usefulUntil = new Date(now + DELIVERY_MARGIN_MS).toISOString()
  for (;;) {
    // `outbox_id` sorts in the order emails were accepted, which keeps two
    // emails queued in the same millisecond first in, first out.
    const { rows } = await db.unsafe<QueueRow>(
      `select ${QUEUE_COLUMNS}
         from mail_queue
        where claimed_at is null and accepted_at is null
          and next_attempt_at <= ${placeholder(db, 1)} and deliver_before > ${placeholder(db, 2)}
        order by lane asc, case when attempts = 0 then 0 else 1 end asc, next_attempt_at asc, outbox_id asc
        limit 1`,
      [at, usefulUntil],
    )
    const row = rows[0]
    if (!row) return null
    const mail = await claim(db, row, at)
    // Another worker took it between the read and the claim: look again.
    if (mail) return mail
  }
}

/**
 * Claim one email whose time to be delivered has run out (or is within the
 * margin of doing so), or null when none has. The worker fails these without
 * sending them, and does so even while delivery is paused.
 */
export async function claimExpiredMail(db: DbClient, now: number): Promise<QueuedMail | null> {
  const at = new Date(now).toISOString()
  const usefulUntil = new Date(now + DELIVERY_MARGIN_MS).toISOString()
  for (;;) {
    const { rows } = await db.unsafe<QueueRow>(
      `select ${QUEUE_COLUMNS}
         from mail_queue
        where claimed_at is null and accepted_at is null and deliver_before <= ${placeholder(db, 1)}
        order by deliver_before asc
        limit 1`,
      [usefulUntil],
    )
    const row = rows[0]
    if (!row) return null
    const mail = await claim(db, row, at)
    if (mail) return mail
  }
}

/**
 * The provider has taken this email. Written first, in one small statement,
 * before the outcome is recorded and the row deleted: a row so marked is
 * never handed to a provider again, whatever becomes of those later steps.
 */
export async function markQueuedMailAccepted(db: DbClient, id: string): Promise<void> {
  await db`update mail_queue set accepted_at = ${nowIso()} where id = ${id}`
}

/**
 * Rows whose email was accepted but whose bookkeeping did not finish (the
 * log update or the delete failed, or the worker died in between).
 */
export async function listAcceptedMail(db: DbClient): Promise<QueuedMail[]> {
  const { rows } = await db.unsafe<QueueRow>(
    `select ${QUEUE_COLUMNS} from mail_queue where accepted_at is not null`,
  )
  return rows.map(toQueuedMail)
}

/**
 * The email left, or was given up on: nothing of it stays in the queue. A
 * plugin's email also gives its place in that plugin's backlog back, in the
 * same transaction, so the count never drifts from the rows.
 */
export async function removeQueuedMail(db: DbClient, mail: Pick<QueuedMail, 'id' | 'source'>): Promise<void> {
  if (mail.source === CORE_MAIL_SOURCE) {
    await db`delete from mail_queue where id = ${mail.id}`
    return
  }
  await db.transaction(async (tx) => {
    const removed = await tx`delete from mail_queue where id = ${mail.id}`
    if (removed.rowCount > 0) await releaseBacklogSlot(tx, mail.source)
  })
}

/**
 * Put a claimed email back to be tried again at `nextAttemptAt`. False when
 * the row is gone: its sender was uninstalled, or its member deleted, while
 * it was being sent.
 */
export async function rescheduleQueuedMail(
  db: DbClient,
  id: string,
  retry: { attempts: number; nextAttemptAt: string; error: string },
): Promise<boolean> {
  const put = await db`
    update mail_queue
       set claimed_at = null, attempts = ${retry.attempts},
           next_attempt_at = ${retry.nextAttemptAt}, last_error = ${retry.error}
     where id = ${id}
  `
  return put.rowCount > 0
}

/**
 * Put a claimed email back exactly as it was, noting why it did not leave.
 * For a failure that is the connector's and not the email's: it is due again
 * the moment delivery resumes, with no attempt counted against it.
 */
export async function holdQueuedMail(db: DbClient, id: string, error: string): Promise<boolean> {
  const put = await db`update mail_queue set claimed_at = null, last_error = ${error} where id = ${id}`
  return put.rowCount > 0
}

/** Every queued email matching a column value, for removing a sender's or a member's mail. */
export async function listQueuedMailBy(
  db: DbClient,
  column: 'source' | 'member_id' | 'kind',
  value: string,
): Promise<QueuedMail[]> {
  const { rows } = await db.unsafe<QueueRow>(
    `select ${QUEUE_COLUMNS} from mail_queue where ${column} = ${placeholder(db, 1)}`,
    [value],
  )
  return rows.map(toQueuedMail)
}

/**
 * Put a claimed email back for a later try without recording anything else:
 * for an attempt whose outcome could not be written down at all.
 */
export async function backOffQueuedMail(db: DbClient, id: string, nextAttemptAt: string): Promise<void> {
  await db`update mail_queue set claimed_at = null, next_attempt_at = ${nextAttemptAt} where id = ${id}`
}
