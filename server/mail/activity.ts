/**
 * The mail activity log (`mail_outbox`): who each message went to, its
 * subject, which connector carried it and what happened.
 *
 * A body is stored only for `captured` rows, which exist only on a
 * development server: bodies carry live sign-in and reset links, so a
 * production database never holds one.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { isoDate } from '@core/utils/isoDate'
import type { MailActivityEntry, MailActivityResponse, MailActivityStatus } from '@core/mail'

/**
 * Row ids sort in the order rows were written. Two emails are easily logged
 * within the same millisecond, and `created_at` alone would then list them
 * in an arbitrary order; the id breaks that tie the way it happened.
 */
let sequence = 0
function orderedId(now: number): string {
  sequence = (sequence + 1) % 1_679_616 // 36^4
  return `${now.toString(36).padStart(9, '0')}${sequence.toString(36).padStart(4, '0')}${nanoid(8)}`
}

/** Rows kept; older ones are pruned on every insert. */
const RETENTION = 2000
const DAY_MS = 24 * 60 * 60 * 1000

interface ActivityRow {
  id: string
  kind: string
  to_address: string
  subject: string
  status: string
  connector_label: string | null
  error: string | null
  body_text: string | null
  created_at: Date | string
}

interface RecordMailInput {
  kind: string
  to: string
  subject: string
  status: MailActivityStatus
  connector?: { id: string; label: string }
  error?: string
  /** Pass only for a captured message. */
  body?: string
}

export async function recordMail(db: DbClient, input: RecordMailInput): Promise<void> {
  const now = Date.now()
  await db`
    insert into mail_outbox (
      id, kind, to_address, subject, status, connector_id, connector_label, error, body_text, created_at
    ) values (
      ${orderedId(now)}, ${input.kind}, ${input.to}, ${input.subject}, ${input.status},
      ${input.connector?.id ?? null}, ${input.connector?.label ?? null}, ${input.error ?? null},
      ${input.status === 'captured' ? (input.body ?? null) : null}, ${new Date(now).toISOString()}
    )
  `
  await db`
    delete from mail_outbox
     where id not in (
       select id from mail_outbox order by created_at desc, id desc limit ${RETENTION}
     )
  `
}

function isStatus(value: string): value is MailActivityStatus {
  return value === 'sent' || value === 'failed' || value === 'captured'
}

function toEntry(row: ActivityRow): MailActivityEntry {
  return {
    id: row.id,
    kind: row.kind,
    to: row.to_address,
    subject: row.subject,
    status: isStatus(row.status) ? row.status : 'failed',
    connectorLabel: row.connector_label,
    error: row.error,
    body: row.body_text,
    createdAt: isoDate(row.created_at),
  }
}

export async function listMailActivity(
  db: DbClient,
  filter: { status?: MailActivityStatus; limit?: number } = {},
): Promise<MailActivityResponse> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const { rows } = filter.status
    ? await db<ActivityRow>`
        select id, kind, to_address, subject, status, connector_label, error, body_text, created_at
          from mail_outbox where status = ${filter.status}
         order by created_at desc, id desc limit ${limit}
      `
    : await db<ActivityRow>`
        select id, kind, to_address, subject, status, connector_label, error, body_text, created_at
          from mail_outbox
         order by created_at desc, id desc limit ${limit}
      `
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString()
  const { rows: counts } = await db<{ status: string; total: number }>`
    select status, count(*) as total from mail_outbox where created_at > ${since} group by status
  `
  const totals = { sent: 0, failed: 0, captured: 0 }
  for (const row of counts) {
    if (isStatus(row.status)) totals[row.status] = Number(row.total)
  }
  return { entries: rows.map(toEntry), totals }
}
