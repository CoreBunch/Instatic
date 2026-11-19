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
import {
  getMailTemplateDefinition,
  type MailActivityCounts,
  type MailActivityEntry,
  type MailActivityPeriod,
  type MailActivityResponse,
  type MailActivityStatus,
} from '@core/mail'

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

/**
 * Rows kept per sender (the core, and each plugin on its own); older ones
 * are pruned on every insert. Per sender, so a plugin that sends a great
 * deal cannot push the core's sign-in emails out of the log. A row whose
 * email is still queued is never pruned: the queue would be left sending
 * something the log has no record of.
 */
const RETENTION = 2000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const PAGE_SIZE = 50
/** The most day columns the chart draws for "all time". */
const MAX_DAY_BUCKETS = 90
/** The `kind` a connector test is logged under: it has no template. */
export const CONNECTOR_TEST_KIND = 'test'

interface ActivityRow {
  id: string
  kind: string
  to_address: string
  subject: string
  status: string
  connector_label: string | null
  error: string | null
  provider_message_id: string | null
  duration_ms: number | null
  attempts: number
  next_attempt_at: Date | string | null
  source: string
  source_label: string | null
  created_at: Date | string
}

interface RecordMailInput {
  kind: string
  to: string
  subject: string
  status: MailActivityStatus
  connector?: { id: string; label: string }
  error?: string
  /** The id the provider answered with, when it gave one. */
  providerMessageId?: string | null
  /** How long the hand-over to the provider took. */
  durationMs?: number
  /** Pass only for a captured message. */
  body?: string
  /** Who asked for the email: `core`, or a plugin's id. */
  source?: string
  /** The sending plugin's name, kept on the row so it outlives the plugin. */
  sourceLabel?: string
  /** Delivery attempts made; an email sent directly counts as one. */
  attempts?: number
}

/** The `source` of an email the core sends itself. */
export const CORE_MAIL_SOURCE = 'core'

/** Write one row and return its id, so a queued email can be settled later. */
export async function recordMail(db: DbClient, input: RecordMailInput): Promise<string> {
  const now = Date.now()
  const id = orderedId(now)
  const at = new Date(now).toISOString()
  const attempts = input.attempts ?? (input.status === 'sent' || input.status === 'failed' ? 1 : 0)
  const source = input.source ?? CORE_MAIL_SOURCE
  await db`
    insert into mail_outbox (
      id, kind, to_address, subject, status, connector_id, connector_label, error,
      provider_message_id, duration_ms, body_text, source, source_label, attempts, next_attempt_at, created_at
    ) values (
      ${id}, ${input.kind}, ${input.to}, ${input.subject}, ${input.status},
      ${input.connector?.id ?? null}, ${input.connector?.label ?? null}, ${input.error ?? null},
      ${input.providerMessageId ?? null}, ${input.durationMs ?? null},
      ${input.status === 'captured' ? (input.body ?? null) : null},
      ${source}, ${input.sourceLabel ?? null}, ${attempts}, ${input.status === 'queued' ? at : null}, ${at}
    )
  `
  await db`
    delete from mail_outbox
     where source = ${source} and status <> 'queued'
       and id not in (
         select id from mail_outbox where source = ${source} order by created_at desc, id desc limit ${RETENTION}
       )
  `
  return id
}

interface MailProgress {
  status: Extract<MailActivityStatus, 'queued' | 'sent' | 'failed'>
  attempts: number
  /** When a still-queued email is tried next. */
  nextAttemptAt?: string
  connector?: { id: string; label: string }
  error?: string
  providerMessageId?: string | null
  durationMs?: number
}

/**
 * Bring a queued email's row up to date after an attempt. A row the log has
 * already pruned is simply not there to update.
 */
export async function updateMailProgress(db: DbClient, id: string, progress: MailProgress): Promise<void> {
  await db`
    update mail_outbox
       set status = ${progress.status},
           attempts = ${progress.attempts},
           next_attempt_at = ${progress.status === 'queued' ? (progress.nextAttemptAt ?? null) : null},
           connector_id = ${progress.connector?.id ?? null},
           connector_label = ${progress.connector?.label ?? null},
           error = ${progress.error ?? null},
           provider_message_id = ${progress.providerMessageId ?? null},
           duration_ms = ${progress.durationMs ?? null}
     where id = ${id}
  `
}

/**
 * Mark an email sent without touching what an earlier, interrupted update
 * may already have written about how it left.
 */
export async function markMailSent(db: DbClient, id: string, attempts: number): Promise<void> {
  await db`
    update mail_outbox
       set status = 'sent', attempts = ${attempts}, next_attempt_at = null, error = null
     where id = ${id} and status <> 'sent'
  `
}

function isStatus(value: string): value is MailActivityStatus {
  return value === 'queued' || value === 'sent' || value === 'failed' || value === 'captured'
}

function kindLabel(kind: string): string {
  if (kind === CONNECTOR_TEST_KIND) return 'Connector test'
  return getMailTemplateDefinition(kind)?.label ?? kind
}

interface LoggedMail extends Omit<MailActivityEntry, 'body'> {
  /** Milliseconds since the epoch, for the period and the buckets. */
  at: number
}

function toLoggedMail(row: ActivityRow): LoggedMail {
  const createdAt = isoDate(row.created_at)
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: kindLabel(row.kind),
    template: getMailTemplateDefinition(row.kind) !== undefined,
    to: row.to_address,
    subject: row.subject,
    status: isStatus(row.status) ? row.status : 'failed',
    connectorLabel: row.connector_label,
    error: row.error,
    providerMessageId: row.provider_message_id,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    attempts: Number(row.attempts),
    // The plugin's name as it was when the email was accepted; its id if that was not kept.
    sentBy: row.source === CORE_MAIL_SOURCE ? null : (row.source_label ?? row.source),
    nextAttemptAt: row.next_attempt_at === null ? null : isoDate(row.next_attempt_at),
    createdAt,
    at: Date.parse(createdAt),
  }
}

export interface MailActivityFilter {
  period?: MailActivityPeriod
  /** The viewer's IANA time zone: days in the chart are the viewer's days. */
  timeZone?: string
  status?: MailActivityStatus
  kind?: string
  /** A connector's label, as logged at the time. */
  connector?: string
  /** Matches the recipient or the subject. */
  search?: string
  /** The id of the last entry already shown. */
  before?: string
  limit?: number
}

const DAYS_IN_PERIOD: Record<Exclude<MailActivityPeriod, '24h' | 'all'>, number> = { '7d': 7, '30d': 30 }

/** A formatter that turns an instant into the viewer's calendar day, `YYYY-MM-DD`. */
function dayFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch (_err) {
    // An unknown zone name from the client: UTC days are still a correct chart.
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
  }
}

/** The `count` calendar days ending on `lastDay`, oldest first. */
function daysEndingOn(lastDay: string, count: number): string[] {
  const [year, month, day] = lastDay.split('-').map(Number)
  return Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(year, month - 1, day - (count - 1 - index))).toISOString().slice(0, 10),
  )
}

/**
 * The bucket starts of a period and the function that puts an email in one.
 * `24h` is the last 24 hours by the hour; the others are whole calendar days
 * in the viewer's zone, so "7 days" is today and the six days before it.
 */
function periodBuckets(
  period: MailActivityPeriod,
  mails: readonly LoggedMail[],
  timeZone: string | undefined,
  now: number,
): { starts: string[]; bucketOf: (mail: LoggedMail) => string } {
  if (period === '24h') {
    const lastHour = Math.floor(now / HOUR_MS) * HOUR_MS
    return {
      starts: Array.from({ length: 24 }, (_, index) => new Date(lastHour - (23 - index) * HOUR_MS).toISOString()),
      bucketOf: (mail) => new Date(Math.floor(mail.at / HOUR_MS) * HOUR_MS).toISOString(),
    }
  }
  const formatter = dayFormatter(timeZone)
  const today = formatter.format(now)
  const bucketOf = (mail: LoggedMail) => formatter.format(mail.at)
  if (period !== 'all') return { starts: daysEndingOn(today, DAYS_IN_PERIOD[period]), bucketOf }
  const oldest = mails.length > 0 ? formatter.format(mails[mails.length - 1].at) : today
  const span = Math.round((Date.parse(today) - Date.parse(oldest)) / DAY_MS) + 1
  return { starts: daysEndingOn(today, Math.min(Math.max(span, 1), MAX_DAY_BUCKETS)), bucketOf }
}

function facets(mails: readonly LoggedMail[], pick: (mail: LoggedMail) => { value: string; label: string } | null) {
  const found = new Map<string, { value: string; label: string; count: number }>()
  for (const mail of mails) {
    const facet = pick(mail)
    if (!facet) continue
    const entry = found.get(facet.value) ?? { ...facet, count: 0 }
    entry.count += 1
    found.set(facet.value, entry)
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * The activity log for the admin: one page of matching emails plus the
 * period's totals, chart buckets and filter menus.
 *
 * The log is capped at `RETENTION` rows, so the whole of it is read (without
 * bodies) and filtered here. That keeps the search, the day buckets in the
 * viewer's zone and the totals identical on SQLite and Postgres.
 */
export async function listMailActivity(
  db: DbClient,
  filter: MailActivityFilter = {},
  now: number = Date.now(),
): Promise<MailActivityResponse> {
  const { rows } = await db<ActivityRow>`
    select id, kind, to_address, subject, status, connector_label, error,
           provider_message_id, duration_ms, attempts, next_attempt_at, source, source_label, created_at
      from mail_outbox
     order by created_at desc, id desc
  `
  const all = rows.map(toLoggedMail)
  const period = filter.period ?? 'all'
  const { starts, bucketOf } = periodBuckets(period, all, filter.timeZone, now)
  const inPeriod =
    period === 'all' ? all : all.filter((mail) => (period === '24h' ? mail.at > now - DAY_MS : bucketOf(mail) >= starts[0]))

  const totals: MailActivityCounts = { queued: 0, sent: 0, failed: 0, captured: 0 }
  const byBucket = new Map(starts.map((start) => [start, { start, queued: 0, sent: 0, failed: 0, captured: 0 }]))
  for (const mail of inPeriod) {
    totals[mail.status] += 1
    const bucket = byBucket.get(bucketOf(mail))
    if (bucket) bucket[mail.status] += 1
  }
  const failure = inPeriod.find((mail) => mail.status === 'failed')
  const held = inPeriod.find((mail) => mail.status === 'queued' && mail.error !== null)

  const search = filter.search?.trim().toLowerCase() ?? ''
  const matching = inPeriod.filter(
    (mail) =>
      (!filter.status || mail.status === filter.status) &&
      (!filter.kind || mail.kind === filter.kind) &&
      (!filter.connector || mail.connectorLabel === filter.connector) &&
      (search === '' || mail.to.toLowerCase().includes(search) || mail.subject.toLowerCase().includes(search)),
  )
  const limit = Math.min(Math.max(filter.limit ?? PAGE_SIZE, 1), 200)
  const from = filter.before ? matching.findIndex((mail) => mail.id === filter.before) + 1 : 0
  const page = matching.slice(from, from + limit)

  // Bodies exist only for captured mail, which exists only on a development server.
  const bodies = new Map<string, string>()
  if (page.some((mail) => mail.status === 'captured')) {
    const { rows: captured } = await db<{ id: string; body_text: string | null }>`
      select id, body_text from mail_outbox where status = 'captured'
    `
    for (const row of captured) if (row.body_text !== null) bodies.set(row.id, row.body_text)
  }

  return {
    entries: page.map(({ at: _at, ...mail }) => ({ ...mail, body: bodies.get(mail.id) ?? null })),
    nextCursor: from + limit < matching.length ? page[page.length - 1].id : null,
    matching: matching.length,
    totals,
    buckets: [...byBucket.values()],
    lastFailure: failure ? { at: failure.createdAt, error: failure.error ?? 'Delivery failed' } : null,
    waitingError: held?.error ?? null,
    kinds: facets(inPeriod, (mail) => ({ value: mail.kind, label: mail.kindLabel })),
    connectors: facets(inPeriod, (mail) =>
      mail.connectorLabel ? { value: mail.connectorLabel, label: mail.connectorLabel } : null,
    ),
    retention: RETENTION,
  }
}
