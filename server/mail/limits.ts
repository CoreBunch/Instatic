/**
 * The two limits on email a plugin asks for. Load is not one of them: mail
 * over the worker's pace simply waits in the queue. These refuse what only a
 * bug or abuse produces: a stream of email at one address, and a backlog no
 * honest plugin builds.
 */
import type { DbClient } from '../db/client'

/** The most emails one plugin may send one recipient in an hour. */
export const MAIL_PER_RECIPIENT_HOURLY_LIMIT = 20
/** The most emails one plugin may have waiting in the queue. */
export const MAIL_BACKLOG_LIMIT = 10_000
const HOUR_MS = 60 * 60 * 1000

export class MailLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailLimitError'
  }
}

/** Throw when `source` may not queue another email for `to` right now. */
export async function assertWithinMailLimits(
  db: DbClient,
  source: string,
  to: string,
  now: number = Date.now(),
): Promise<void> {
  // The activity log holds every email accepted, sent or not, so it counts
  // an hour of them even after the queue rows are gone. The comparison is
  // case-insensitive: `A@x.example` and `a@x.example` are one inbox.
  const recent = await db<{ n: number | string }>`
    select count(*) as n from mail_outbox
     where source = ${source}
       and lower(to_address) = ${to.toLowerCase()}
       and created_at > ${new Date(now - HOUR_MS).toISOString()}
  `
  if (Number(recent.rows[0]?.n ?? 0) >= MAIL_PER_RECIPIENT_HOURLY_LIMIT) {
    throw new MailLimitError(
      `This plugin has already sent ${MAIL_PER_RECIPIENT_HOURLY_LIMIT} emails to that recipient in the last hour.`,
    )
  }
  const waiting = await db<{ n: number | string }>`
    select count(*) as n from mail_queue where source = ${source}
  `
  if (Number(waiting.rows[0]?.n ?? 0) >= MAIL_BACKLOG_LIMIT) {
    throw new MailLimitError(
      `This plugin already has ${MAIL_BACKLOG_LIMIT.toLocaleString('en-US')} emails waiting to be sent.`,
    )
  }
}
