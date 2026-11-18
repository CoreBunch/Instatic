/**
 * The two limits on email a plugin asks for. Load is not one of them: mail
 * over the worker's pace simply waits in the queue. These refuse what only a
 * bug or abuse produces: a stream of email at one address, and a backlog no
 * honest plugin builds.
 *
 * Both are counters in `mail_counters`, raised by one conditional UPDATE
 * (`... set count = count + 1 where count < limit`). The database decides,
 * atomically, whether there is a place left, so concurrent sends, on one
 * server or on several sharing a Postgres database, can never exceed a
 * limit. Callers reserve inside the transaction that accepts the email: an
 * email that is not accepted after all gives its places back with the
 * rollback.
 */
import type { DbClient } from '../db/client'

/** The most emails one plugin may send one recipient within a clock hour. */
export const MAIL_PER_RECIPIENT_HOURLY_LIMIT = 20
/**
 * The most emails one plugin may send to addresses it names itself within a
 * clock hour. Email to members is bounded by the per-member limit and by how
 * many members there are; email to arbitrary addresses is bounded by
 * nothing else, and it spends the provider quota the site's own sign-in
 * email depends on.
 */
export const MAIL_EXTERNAL_HOURLY_LIMIT = 200
/** The most emails one plugin may have waiting in the queue. */
export const MAIL_BACKLOG_LIMIT = 10_000
const HOUR_MS = 60 * 60 * 1000
const BACKLOG_SCOPE = 'backlog'
const EXTERNAL_SCOPE = 'external'

export class MailLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailLimitError'
  }
}

/** The clock hour an instant falls in, `YYYY-MM-DDTHH` (UTC). Sorts as text. */
function hourBucket(at: number): string {
  return new Date(at).toISOString().slice(0, 13)
}

/** A recipient the way the sender named it: a site member, or an address. */
export type MailRecipient = { member: string } | { address: string }

/**
 * The counter a recipient is counted under. A member is counted by id and an
 * address by itself (`A@x.example` and `a@x.example` are one inbox), and the
 * two are never merged: if emailing member X used up the places of X's
 * address, a sender could learn that address by watching which one is refused.
 */
function recipientScope(recipient: MailRecipient): string {
  return 'member' in recipient ? `member:${recipient.member}` : `to:${recipient.address.trim().toLowerCase()}`
}

/** Take one place in a counter, or report that it is full. */
async function takePlace(
  db: DbClient,
  counter: { source: string; scope: string; bucket: string },
  limit: number,
): Promise<boolean> {
  await db`
    insert into mail_counters (source, scope, bucket, count)
    values (${counter.source}, ${counter.scope}, ${counter.bucket}, 0)
    on conflict (source, scope, bucket) do nothing
  `
  const taken = await db`
    update mail_counters set count = count + 1
     where source = ${counter.source} and scope = ${counter.scope} and bucket = ${counter.bucket}
       and count < ${limit}
  `
  return taken.rowCount > 0
}

/**
 * Count one more email from `source` to `recipient` in this clock hour, and,
 * for an address, one more of the plugin's external emails. Throws
 * `MailLimitError` when either hour's places are taken. Call inside the
 * transaction that accepts the email.
 */
export async function reserveRecipientSlot(
  tx: DbClient,
  source: string,
  recipient: MailRecipient,
  now: number = Date.now(),
): Promise<void> {
  // Hours that are over count for nothing any more.
  await tx`
    delete from mail_counters
     where source = ${source} and scope <> ${BACKLOG_SCOPE} and bucket < ${hourBucket(now - HOUR_MS)}
  `
  const taken = await takePlace(tx, { source, scope: recipientScope(recipient), bucket: hourBucket(now) }, MAIL_PER_RECIPIENT_HOURLY_LIMIT)
  if (!taken) {
    throw new MailLimitError(
      `This plugin has already sent ${MAIL_PER_RECIPIENT_HOURLY_LIMIT} emails to that recipient this hour.`,
    )
  }
  if ('address' in recipient) {
    const within = await takePlace(tx, { source, scope: EXTERNAL_SCOPE, bucket: hourBucket(now) }, MAIL_EXTERNAL_HOURLY_LIMIT)
    if (!within) {
      throw new MailLimitError(
        `This plugin has already sent ${MAIL_EXTERNAL_HOURLY_LIMIT} emails to addresses outside the site's members this hour.`,
      )
    }
  }
}

/**
 * Count one more of `source`'s emails as waiting. Throws `MailLimitError`
 * when the backlog is full. Call inside the transaction that queues it.
 */
export async function reserveBacklogSlot(tx: DbClient, source: string): Promise<void> {
  const taken = await takePlace(tx, { source, scope: BACKLOG_SCOPE, bucket: '' }, MAIL_BACKLOG_LIMIT)
  if (!taken) {
    throw new MailLimitError(
      `This plugin already has ${MAIL_BACKLOG_LIMIT.toLocaleString('en-US')} emails waiting to be sent.`,
    )
  }
}

/** One of `source`'s emails left the queue. Call inside the transaction that removes it. */
export async function releaseBacklogSlot(tx: DbClient, source: string): Promise<void> {
  await tx`
    update mail_counters set count = count - 1
     where source = ${source} and scope = ${BACKLOG_SCOPE} and bucket = '' and count > 0
  `
}

/** Forget every counter of a plugin that is gone. */
export async function clearMailCounters(db: DbClient, source: string): Promise<void> {
  await db`delete from mail_counters where source = ${source}`
}
