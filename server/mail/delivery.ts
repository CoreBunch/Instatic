/**
 * Queued delivery: how every email nobody is waiting on leaves the server.
 *
 * `queueTemplateMail` accepts an email and returns at once. One worker per
 * process drains the queue: it hands each email to the site's connector,
 * and when the provider is unreachable, busy or rate-limiting, it tries
 * again with growing pauses for about a day before giving up. The activity
 * log follows each email from `queued` to `sent` or `failed`.
 *
 * Guarantees and their edges:
 *
 *  - **At least once.** A row is deleted after the provider accepts the
 *    email. A process that dies between those two steps leaves a claimed
 *    row, which is released after ten minutes and sent again.
 *  - **One sender at a time.** A drain runs under the scheduler leader lock,
 *    so several server instances on one Postgres database pace themselves
 *    as one. SQLite is single-process.
 *  - **Core mail first.** The queue is ordered by lane, so a plugin's
 *    backlog never delays a sign-in or reset link.
 */
import type { DbClient } from '../db/client'
import { withSchedulerLeaderLock } from '../db/advisoryLock'
import { getMailTemplateDefinition } from '@core/mail'
import { getErrorMessage } from '@core/utils/errorMessage'
import { CORE_MAIL_SOURCE, recordMail, updateMailProgress } from './activity'
import { getMailDefaults } from './defaults'
import { reserveBacklogSlot, reserveRecipientSlot } from './limits'
import {
  claimNextDueMail,
  enqueueMail,
  readQueuedVariables,
  releaseStaleMailClaims,
  removeQueuedMail,
  rescheduleQueuedMail,
  type QueuedMail,
} from './queue'
import {
  assertSendable,
  buildTemplateMail,
  captureAllowed,
  carryThroughConnector,
  MailNotConfiguredError,
  readyToSend,
  type CarryOutcome,
  type SendDeps,
} from './send'
import type { MailRetry } from './smtpDriver'

/** How often an idle worker looks for due retries (and for another instance's mail). */
const TICK_INTERVAL_MS = 15_000
/** The pause between two emails: ten a second through one connector. */
const PACE_MS = 100
/** After a provider says "slow down", nothing is sent for this long. */
const SLOW_DOWN_PAUSE_MS = 60_000
/** An email still undelivered after this long is given up on. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000
/** The wait before each retry; the last entry repeats. About 22 hours in all. */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 4 * 3_600_000, 6 * 3_600_000, 8 * 3_600_000]
/** Each wait is moved by up to this share either way, so retries do not arrive in step. */
const RETRY_JITTER = 0.2
/** djb2('instatic-mail-queue') mod 2^31; distinct from the other tick loops' keys. */
const ADVISORY_LOCK_KEY = 1_410_772_963

export interface QueueTemplateMailInput {
  key: string
  to: string
  variables: Record<string, string>
  /** Who asks: omitted for the core's own mail, a plugin's id otherwise. */
  source?: string
  /** The sender's own name for this email, handed back with the outcome. */
  reference?: string
  /**
   * The site member the email is for, when the sender named a member and
   * the host looked the address up. The outcome then names the member, never
   * the address: a sender that was not given the address does not learn it.
   */
  memberId?: string
}

/** What became of a queued email that was not the core's own. */
export interface QueuedMailOutcome {
  source: string
  /** The template key. */
  kind: string
  /** The recipient exactly as the sender named it. */
  recipient: { member: string } | { address: string }
  reference: string | null
  status: 'sent' | 'failed'
  error: string | null
}

let outcomeHandler: ((outcome: QueuedMailOutcome) => void) | null = null

/**
 * Hear what becomes of every queued email that has a `source` other than
 * the core. The plugin host uses this to tell a plugin about its own mail.
 */
export function setQueuedMailOutcomeHandler(handler: ((outcome: QueuedMailOutcome) => void) | null): void {
  outcomeHandler = handler
}

/**
 * A provider's refusal can quote the recipient ("Invalid `to`: a@b.example").
 * When the sender named a member, that address is not the sender's to see.
 */
function withoutAddress(message: string, address: string): string {
  return message.split(new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join('the member\'s address')
}

function announceOutcome(mail: QueuedMail, status: 'sent' | 'failed', error: string | null): void {
  if (mail.source === CORE_MAIL_SOURCE || !outcomeHandler) return
  const forMember = mail.memberId !== null
  try {
    outcomeHandler({
      source: mail.source,
      kind: mail.kind,
      recipient: mail.memberId !== null ? { member: mail.memberId } : { address: mail.to },
      reference: mail.reference,
      status,
      error: error !== null && forMember ? withoutAddress(error, mail.to) : error,
    })
  } catch (err) {
    console.error('[mail] outcome handler threw:', getErrorMessage(err, 'unknown error'))
  }
}

/**
 * Accept an email for delivery. Resolves `queued` once it is safely stored,
 * or `captured` on a development server with no connector. Throws
 * `MailNotConfiguredError` in production when email is not set up, and
 * `MailDeliveryError` for a recipient or subject that could add headers:
 * both are known before anything is queued.
 */
export async function queueTemplateMail(
  db: DbClient,
  input: QueueTemplateMailInput,
  deps: Pick<SendDeps, 'env'> = {},
): Promise<'queued' | 'captured'> {
  // Rendering now proves the template exists and gives the log its subject.
  // The email is rendered again when it is sent, with the wording of then.
  const mail = await buildTemplateMail(db, input)
  assertSendable(mail)
  const log = { kind: mail.kind, to: mail.to, subject: mail.subject, source: input.source }
  // A plugin's email takes its places in that plugin's limits inside the
  // transaction that accepts it, so a refusal or a failure gives them back.
  const limited = input.source !== undefined && input.source !== CORE_MAIL_SOURCE ? input.source : null
  if (!readyToSend(await getMailDefaults(db))) {
    if (!captureAllowed(deps.env ?? process.env)) throw new MailNotConfiguredError()
    await db.transaction(async (tx) => {
      if (limited) await reserveRecipientSlot(tx, limited, input.to)
      await recordMail(tx, { ...log, status: 'captured', body: mail.text })
    })
    return 'captured'
  }
  // One transaction: the log never shows a waiting email the queue does not hold.
  await db.transaction(async (tx) => {
    if (limited) {
      await reserveRecipientSlot(tx, limited, input.to)
      await reserveBacklogSlot(tx, limited)
    }
    const outboxId = await recordMail(tx, { ...log, status: 'queued' })
    await enqueueMail(tx, {
      outboxId,
      kind: input.key,
      to: input.to,
      variables: input.variables,
      source: input.source,
      reference: input.reference,
      memberId: input.memberId,
    })
  })
  wakeMailQueue()
  return 'queued'
}

/** The wait before retry number `attempts`, with jitter. `random` is in [0, 1). */
export function mailRetryDelayMs(attempts: number, random: number = Math.random()): number {
  const base = RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1]
  return Math.round(base * (1 + (random * 2 - 1) * RETRY_JITTER))
}

interface DrainDeps extends Pick<SendDeps, 'carrier'> {
  now?: () => number
  random?: () => number
  /** The pause between two emails. Tests pass 0. */
  paceMs?: number
}

/** Until when a rate-limiting provider is left alone. One connector sends, so one value. */
let pausedUntil = 0
/** Set by `stopMailQueue`: the drain in progress finishes its email and returns. */
let stopping = false

type Attempt =
  | { sent: true; outcome: Extract<CarryOutcome, { ok: true }> }
  | { sent: false; message: string; retry: MailRetry; outcome?: Extract<CarryOutcome, { ok: false }> }

/** Try one queued email once. */
async function attemptQueuedMail(db: DbClient, mail: QueuedMail, deps: DrainDeps): Promise<Attempt> {
  let variables: Record<string, string>
  try {
    variables = await readQueuedVariables(mail)
  } catch (_err) {
    // The master key changed since the email was accepted: its values, and
    // the links in them, are gone for good.
    return { sent: false, message: 'The queued email can no longer be read with the current server secret key.', retry: 'never' }
  }
  const defaults = await getMailDefaults(db)
  if (!readyToSend(defaults)) {
    return { sent: false, message: new MailNotConfiguredError().message, retry: 'later' }
  }
  let rendered
  try {
    rendered = await buildTemplateMail(db, { key: mail.kind, to: mail.to, variables })
    assertSendable(rendered)
  } catch (err) {
    // The template was removed (its plugin was disabled or uninstalled) or
    // no longer renders a sendable message. Another try would end the same way.
    const message = getMailTemplateDefinition(mail.kind)
      ? getErrorMessage(err, 'The email could not be prepared.')
      : 'The template of this email no longer exists: the plugin it belongs to was disabled or removed.'
    return { sent: false, message, retry: 'never' }
  }
  const outcome = await carryThroughConnector(db, defaults.defaultConnectorId, defaults, rendered, deps.carrier)
  return outcome.ok ? { sent: true, outcome } : { sent: false, message: outcome.message, retry: outcome.retry, outcome }
}

/** Record what an attempt came to and take the email out of the queue, or put it back. */
async function settleQueuedMail(db: DbClient, mail: QueuedMail, attempt: Attempt, deps: DrainDeps): Promise<void> {
  const now = (deps.now ?? Date.now)()
  const attempts = mail.attempts + 1
  if (attempt.sent) {
    await updateMailProgress(db, mail.outboxId, {
      status: 'sent',
      attempts,
      connector: attempt.outcome.connector,
      providerMessageId: attempt.outcome.providerMessageId,
      durationMs: attempt.outcome.durationMs,
    })
    await removeQueuedMail(db, mail)
    announceOutcome(mail, 'sent', null)
    return
  }
  const failure = {
    attempts,
    connector: attempt.outcome?.connector,
    error: attempt.message,
    durationMs: attempt.outcome?.durationMs,
  }
  const delay = mailRetryDelayMs(attempts, (deps.random ?? Math.random)())
  if (attempt.retry === 'slow-down') pausedUntil = now + SLOW_DOWN_PAUSE_MS
  if (attempt.retry === 'never' || now + delay > mail.createdAt + GIVE_UP_AFTER_MS) {
    await updateMailProgress(db, mail.outboxId, { ...failure, status: 'failed' })
    await removeQueuedMail(db, mail)
    console.error(`[mail] gave up on a "${mail.kind}" email after ${attempts} attempt(s)`)
    announceOutcome(mail, 'failed', attempt.message)
    return
  }
  const nextAttemptAt = new Date(now + delay).toISOString()
  await updateMailProgress(db, mail.outboxId, { ...failure, status: 'queued', nextAttemptAt })
  await rescheduleQueuedMail(db, mail.id, { attempts, nextAttemptAt, error: attempt.message })
}

/**
 * Send everything that is due, one email after another, then return. A
 * no-op when another server instance is draining. Exported for tests;
 * production code calls `startMailQueue` and `wakeMailQueue`.
 */
export async function drainMailQueue(db: DbClient, deps: DrainDeps = {}): Promise<void> {
  const clock = deps.now ?? Date.now
  await withSchedulerLeaderLock(db, ADVISORY_LOCK_KEY, '[mail]', async () => {
    await releaseStaleMailClaims(db, clock())
    while (!stopping && clock() >= pausedUntil) {
      const mail = await claimNextDueMail(db, clock())
      if (!mail) break
      let attempt: Attempt
      try {
        attempt = await attemptQueuedMail(db, mail, deps)
      } catch (err) {
        // Not a delivery answer (the database, a bug): leave the email for a later try.
        attempt = { sent: false, message: getErrorMessage(err, 'Delivery failed'), retry: 'later' }
      }
      await settleQueuedMail(db, mail, attempt, deps)
      const pace = deps.paceMs ?? PACE_MS
      if (pace > 0) await new Promise((resolve) => setTimeout(resolve, pace))
    }
  })
}

let boundDb: DbClient | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let draining: Promise<void> | null = null
let wakeAgain = false

function runDrain(): void {
  if (!boundDb || stopping) return
  if (draining) {
    // A drain may be past the row that was just added: go round once more.
    wakeAgain = true
    return
  }
  const db = boundDb
  draining = drainMailQueue(db)
    .catch((err: unknown) => {
      console.error('[mail] queue drain failed:', getErrorMessage(err, 'unknown error'))
    })
    .finally(() => {
      draining = null
      if (wakeAgain) {
        wakeAgain = false
        runDrain()
      }
    })
}

/** Start the worker. Idempotent: a second call re-points it at `db`. */
export function startMailQueue(db: DbClient): void {
  boundDb = db
  stopping = false
  if (tickTimer !== null) return
  tickTimer = setInterval(runDrain, TICK_INTERVAL_MS)
  // Whatever a previous process left behind goes out now.
  runDrain()
}

/** Send what was just queued without waiting for the next tick. */
export function wakeMailQueue(): void {
  runDrain()
}

/**
 * Stop the worker and wait for the email in hand, so a shutdown never cuts
 * a hand-over in half. What is still queued goes out after the restart.
 */
export async function stopMailQueue(): Promise<void> {
  stopping = true
  if (tickTimer !== null) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  await draining
  boundDb = null
}

/** Test seam: forget a provider's "slow down" between tests. */
export function __resetMailQueuePauseForTesting(): void {
  pausedUntil = 0
  stopping = false
}
