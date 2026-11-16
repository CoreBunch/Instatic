/**
 * Delivery log for outgoing mail (`mail_outbox`).
 *
 * A row records who a message went to, its subject and what happened. The
 * body is stored only for `captured` rows, which exist only on a development
 * server: bodies carry live sign-in and reset links, so a production database
 * never holds one.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { isoDate, nowIso } from '@core/utils/isoDate'
import type { MailOutboxEntry, MailOutboxStatus } from '@core/mail'

/** Rows kept; older ones are pruned on every insert. */
const OUTBOX_RETENTION = 500

interface MailOutboxRow {
  id: string
  kind: string
  to_address: string
  subject: string
  status: string
  error: string | null
  body_text: string | null
  created_at: Date | string
}

interface RecordMailInput {
  kind: string
  to: string
  subject: string
  status: MailOutboxStatus
  error?: string
  /** Pass only for a captured message. */
  body?: string
}

export async function recordMail(db: DbClient, input: RecordMailInput): Promise<void> {
  await db`
    insert into mail_outbox (id, kind, to_address, subject, status, error, body_text, created_at)
    values (
      ${nanoid()}, ${input.kind}, ${input.to}, ${input.subject}, ${input.status},
      ${input.error ?? null}, ${input.status === 'captured' ? (input.body ?? null) : null},
      ${nowIso()}
    )
  `
  await db`
    delete from mail_outbox
     where id not in (
       select id from mail_outbox order by created_at desc, id desc limit ${OUTBOX_RETENTION}
     )
  `
}

export async function listMailOutbox(db: DbClient, limit = 50): Promise<MailOutboxEntry[]> {
  const { rows } = await db<MailOutboxRow>`
    select id, kind, to_address, subject, status, error, body_text, created_at
      from mail_outbox
     order by created_at desc, id desc
     limit ${limit}
  `
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    to: row.to_address,
    subject: row.subject,
    status: row.status as MailOutboxStatus,
    error: row.error,
    body: row.body_text,
    createdAt: isoDate(row.created_at),
  }))
}
