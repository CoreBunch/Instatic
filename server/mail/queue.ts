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
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { Type, type Static } from '@sinclair/typebox'
import { safeParseJson } from '@core/utils/jsonValidate'
import { isoDate, nowIso } from '@core/utils/isoDate'
import { decryptSecret, encryptSecret } from '../secrets/encryption'
import { loadMasterKey } from '../secrets/masterKey'
import { CORE_MAIL_SOURCE } from './activity'
import { releaseBacklogSlot } from './limits'

const QueuedPayloadSchema = Type.Object({
  variables: Type.Record(Type.String(), Type.String()),
})
type QueuedPayload = Static<typeof QueuedPayloadSchema>

/** A claim older than this belonged to a process that died mid-send. */
const STALE_CLAIM_MS = 10 * 60 * 1000

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
  created_at: Date | string
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
  /** Milliseconds since the epoch. */
  createdAt: number
  payload: { ciphertext: Uint8Array; iv: Uint8Array }
}

export interface EnqueueMailInput {
  outboxId: string
  kind: string
  to: string
  variables: Record<string, string>
  source?: string
  reference?: string
  /** The site member the email is for, when the sender named one rather than an address. */
  memberId?: string
}

export async function enqueueMail(db: DbClient, input: EnqueueMailInput): Promise<void> {
  const payload: QueuedPayload = { variables: input.variables }
  const encrypted = await encryptSecret(await loadMasterKey(), JSON.stringify(payload))
  const source = input.source ?? CORE_MAIL_SOURCE
  const now = nowIso()
  await db`
    insert into mail_queue (
      id, outbox_id, kind, to_address, source, reference, member_id, lane,
      payload_ciphertext, payload_iv, attempts, next_attempt_at, created_at
    ) values (
      ${nanoid()}, ${input.outboxId}, ${input.kind}, ${input.to}, ${source}, ${input.reference ?? null},
      ${input.memberId ?? null}, ${source === CORE_MAIL_SOURCE ? 0 : 1},
      ${encrypted.ciphertext}, ${encrypted.iv}, 0, ${now}, ${now}
    )
  `
}

/** The values a queued email was accepted with. Throws when they cannot be read. */
export async function readQueuedVariables(mail: QueuedMail): Promise<Record<string, string>> {
  const plaintext = await decryptSecret(await loadMasterKey(), mail.payload)
  const parsed = safeParseJson(plaintext, QueuedPayloadSchema)
  if (!parsed.ok) throw parsed.error
  return parsed.value.variables
}

/**
 * Hand claims left by a process that died back to the queue. An email whose
 * process died after the provider accepted it, but before the row was
 * deleted, is sent a second time: delivery is at least once.
 */
export async function releaseStaleMailClaims(db: DbClient, now: number): Promise<void> {
  await db`
    update mail_queue set claimed_at = null
     where claimed_at is not null and claimed_at < ${new Date(now - STALE_CLAIM_MS).toISOString()}
  `
}

/**
 * Claim the next email that is due, or null when none is. The claim is one
 * conditional update, so two server instances can never both take a row.
 */
export async function claimNextDueMail(db: DbClient, now: number): Promise<QueuedMail | null> {
  const at = new Date(now).toISOString()
  for (;;) {
    const { rows } = await db<QueueRow>`
      select id, outbox_id, kind, to_address, source, reference, member_id,
             payload_ciphertext, payload_iv, attempts, created_at
        from mail_queue
       where claimed_at is null and next_attempt_at <= ${at}
       order by lane asc, next_attempt_at asc, outbox_id asc
       limit 1
    `
    // `outbox_id` sorts in the order emails were accepted, which keeps two
    // emails queued in the same millisecond first in, first out.
    const row = rows[0]
    if (!row) return null
    const claimed = await db`
      update mail_queue set claimed_at = ${at} where id = ${row.id} and claimed_at is null
    `
    // Another instance took it between the read and the claim: look again.
    if (claimed.rowCount === 0) continue
    return {
      id: row.id,
      outboxId: row.outbox_id,
      kind: row.kind,
      to: row.to_address,
      source: row.source,
      reference: row.reference,
      memberId: row.member_id,
      attempts: Number(row.attempts),
      createdAt: Date.parse(isoDate(row.created_at)),
      payload: { ciphertext: row.payload_ciphertext, iv: row.payload_iv },
    }
  }
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

/** Put a claimed email back to be tried again at `nextAttemptAt`. */
export async function rescheduleQueuedMail(
  db: DbClient,
  id: string,
  retry: { attempts: number; nextAttemptAt: string; error: string },
): Promise<void> {
  await db`
    update mail_queue
       set claimed_at = null, attempts = ${retry.attempts},
           next_attempt_at = ${retry.nextAttemptAt}, last_error = ${retry.error}
     where id = ${id}
  `
}
