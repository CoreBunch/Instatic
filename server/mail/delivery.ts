/**
 * Queued delivery: how every email nobody is waiting on leaves the server.
 *
 * `queueTemplateMail` accepts an email and returns at once. A worker in each
 * server process drains the queue: it hands each email to the site's
 * connector, and when the provider is unreachable or busy it tries again
 * with growing pauses, until the email's deadline. The activity log follows
 * each email from `queued` to `sent` or `failed`.
 *
 * Guarantees and their edges:
 *
 *  - **At least once.** A row is deleted after the provider accepts the
 *    email. A worker that dies between those two steps leaves a claimed row,
 *    which is released after a minute and sent again.
 *  - **No lock between workers.** Each row is claimed with one conditional
 *    update (`queue.ts`), so several server instances drain side by side and
 *    none takes an email another has. Pacing and a provider's "slow down"
 *    are per process: each instance learns of a throttle from its own
 *    refused request, which costs one request per instance and nothing else.
 *  - **Never after its deadline.** Every email has a `deliverBefore`: the
 *    expiry of the link it carries, or a day. Past it the email is failed,
 *    not sent: a sign-in link that arrives after it stopped working is worse
 *    than none.
 *  - **A broken connector pauses, it does not retry.** When the provider
 *    refuses the account itself (a wrong key or password), every queued
 *    email is held, the connector shows the error, and delivery resumes when
 *    the secret is replaced or a test send works.
 *  - **Core mail first, new mail before retries.** See `claimNextDueMail`.
 */
import type { DbClient } from '../db/client'
import { getErrorMessage } from '@core/utils/errorMessage'
import { recordMail, updateMailProgress } from './activity'
import { connectorDeliveryPaused, pauseConnectorDelivery } from './connectors'
import { getMailDefaults } from './defaults'
import {
  claimExpiredMail,
  claimNextDueMail,
  encryptQueuedVariables,
  enqueueMail,
  holdQueuedMail,
  QueuedMailUnreadableError,
  readQueuedVariables,
  releaseMailClaim,
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

/** How often an idle worker looks for due retries, expired email and a lifted pause. */
const TICK_INTERVAL_MS = 15_000
/** The pause between two emails: ten a second through one connector. */
const PACE_MS = 100
/** After a provider says "slow down", this process sends nothing for this long. */
const SLOW_DOWN_PAUSE_MS = 60_000
/** How long an email with no deadline of its own may wait to be delivered. */
export const MAIL_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000
/** The wait before each retry; the last entry repeats. About 22 hours in all. */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 4 * 3_600_000, 6 * 3_600_000, 8 * 3_600_000]
/** Each wait is moved by up to this share either way, so retries do not arrive in step. */
const RETRY_JITTER = 0.2

export interface QueueTemplateMailInput {
  key: string
  to: string
  variables: Record<string, string>
  /**
   * After this moment (milliseconds since the epoch) the email is not sent
   * any more. Pass the expiry of the link it carries. Without one the email
   * has a day.
   */
  deliverBefore?: number
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
  const log = { kind: mail.kind, to: mail.to, subject: mail.subject }
  if (!readyToSend(await getMailDefaults(db))) {
    if (!captureAllowed(deps.env ?? process.env)) throw new MailNotConfiguredError()
    await recordMail(db, { ...log, status: 'captured', body: mail.text })
    return 'captured'
  }
  // Encrypted before the transaction opens: see `encryptQueuedVariables`.
  const payload = await encryptQueuedVariables(input.variables)
  const deliverBefore = input.deliverBefore ?? Date.now() + MAIL_DELIVERY_WINDOW_MS
  // One transaction: the log never shows a waiting email the queue does not hold.
  await db.transaction(async (tx) => {
    const outboxId = await recordMail(tx, { ...log, status: 'queued' })
    await enqueueMail(tx, { outboxId, kind: input.key, to: input.to, payload, deliverBefore })
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

/**
 * Until when this process leaves a throttling provider alone. Deliberately
 * not shared between instances: each backs off on its own 429 or 421, and
 * the only cost of not knowing about another's is one refused request.
 */
let pausedUntil = 0
/** Set by `stopMailQueue`: the drain in progress finishes its email and returns. */
let stopping = false

type Attempt =
  | { sent: true; outcome: Extract<CarryOutcome, { ok: true }> }
  | {
      sent: false
      /** The sentence for the activity log. */
      message: string
      retry: MailRetry
      /** The connector to pause, when the failure was a connector's. */
      connectorId?: string
      outcome?: Extract<CarryOutcome, { ok: false }>
    }

/** Try one queued email once. */
async function attemptQueuedMail(db: DbClient, mail: QueuedMail, deps: DrainDeps): Promise<Attempt> {
  let variables: Record<string, string>
  try {
    variables = await readQueuedVariables(mail)
  } catch (err) {
    // Only a failed decryption means the values, and the links in them, are
    // gone for good. Anything else may pass.
    if (err instanceof QueuedMailUnreadableError) return { sent: false, message: err.message, retry: 'never' }
    throw err
  }
  const defaults = await getMailDefaults(db)
  if (!readyToSend(defaults)) {
    return { sent: false, message: new MailNotConfiguredError().message, retry: 'connector' }
  }
  let rendered
  try {
    rendered = await buildTemplateMail(db, { key: mail.kind, to: mail.to, variables })
    assertSendable(rendered)
  } catch (err) {
    // The template was removed (its plugin is gone) or no longer renders a
    // sendable message. Another try would end the same way.
    return { sent: false, message: getErrorMessage(err, 'The email could not be prepared.'), retry: 'never' }
  }
  const outcome = await carryThroughConnector(db, defaults.defaultConnectorId, defaults, rendered, deps.carrier)
  if (outcome.ok) return { sent: true, outcome }
  return {
    sent: false,
    message: outcome.message,
    retry: outcome.retry,
    connectorId: defaults.defaultConnectorId,
    outcome,
  }
}

/** What the drain does after an attempt was settled. */
type AfterAttempt = 'continue' | 'stop'

/** Record what an attempt came to and take the email out of the queue, or put it back. */
async function settleQueuedMail(
  db: DbClient,
  mail: QueuedMail,
  attempt: Attempt,
  deps: DrainDeps,
): Promise<AfterAttempt> {
  const now = (deps.now ?? Date.now)()
  if (attempt.sent) {
    await updateMailProgress(db, mail.outboxId, {
      status: 'sent',
      attempts: mail.attempts + 1,
      connector: attempt.outcome.connector,
      providerMessageId: attempt.outcome.providerMessageId,
      durationMs: attempt.outcome.durationMs,
    })
    await removeQueuedMail(db, mail.id)
    return 'continue'
  }
  const seen = { connector: attempt.outcome?.connector, error: attempt.message, durationMs: attempt.outcome?.durationMs }

  if (attempt.retry === 'connector') {
    // Not this email's failure, so no attempt is counted against it and it
    // is due the moment delivery resumes. The activity log shows the reason
    // now, not after a day of silent retries.
    await updateMailProgress(db, mail.outboxId, { ...seen, status: 'queued', attempts: mail.attempts })
    await holdQueuedMail(db, mail.id, attempt.message)
    if (attempt.connectorId) await pauseConnectorDelivery(db, attempt.connectorId)
    console.error('[mail] delivery is paused: the connector refuses the account or is not set up')
    return 'stop'
  }

  const attempts = mail.attempts + 1
  if (attempt.retry === 'slow-down') pausedUntil = now + SLOW_DOWN_PAUSE_MS
  const delay = mailRetryDelayMs(attempts, (deps.random ?? Math.random)())
  if (attempt.retry === 'never') {
    await updateMailProgress(db, mail.outboxId, { ...seen, attempts, status: 'failed' })
    await removeQueuedMail(db, mail.id)
    console.error(`[mail] gave up on a "${mail.kind}" email after ${attempts} attempt(s)`)
    return 'continue'
  }
  if (now + delay >= mail.deliverBefore) {
    // The next try would come too late to be of use.
    await failExpiredMail(db, mail, { attempts, lastError: attempt.message, connector: seen.connector })
    return 'continue'
  }
  const nextAttemptAt = new Date(now + delay).toISOString()
  await updateMailProgress(db, mail.outboxId, { ...seen, attempts, status: 'queued', nextAttemptAt })
  await rescheduleQueuedMail(db, mail.id, { attempts, nextAttemptAt, error: attempt.message })
  return attempt.retry === 'slow-down' ? 'stop' : 'continue'
}

/** The activity-log sentence of an email that ran out of time. */
export function expiredMailMessage(lastError: string | null): string {
  const reason = 'Not sent: the time in which this email was of use ran out before it could be delivered.'
  return lastError ? `${reason} Last error: ${lastError}` : reason
}

async function failExpiredMail(
  db: DbClient,
  mail: QueuedMail,
  seen: { attempts: number; lastError: string | null; connector?: { id: string; label: string } },
): Promise<void> {
  await updateMailProgress(db, mail.outboxId, {
    status: 'failed',
    attempts: seen.attempts,
    connector: seen.connector,
    error: expiredMailMessage(seen.lastError),
  })
  await removeQueuedMail(db, mail.id)
  console.error(`[mail] a "${mail.kind}" email expired before it could be delivered`)
}

/** Fail, without sending, every email whose deadline has passed. */
async function expireOverdueMail(db: DbClient, now: number): Promise<void> {
  for (;;) {
    const mail = await claimExpiredMail(db, now)
    if (!mail) return
    await failExpiredMail(db, mail, { attempts: mail.attempts, lastError: mail.lastError })
  }
}

/**
 * Send everything that is due, one email after another, then return.
 * Several drains, in one process or in several, may run at once. Exported
 * for tests; production code calls `startMailQueue` and `wakeMailQueue`.
 */
export async function drainMailQueue(db: DbClient, deps: DrainDeps = {}): Promise<void> {
  const clock = deps.now ?? Date.now
  await releaseStaleMailClaims(db, clock())
  // Expired email is failed even while nothing can be sent.
  await expireOverdueMail(db, clock())
  const defaults = await getMailDefaults(db)
  if (readyToSend(defaults) && (await connectorDeliveryPaused(db, defaults.defaultConnectorId))) return

  while (!stopping && clock() >= pausedUntil) {
    const mail = await claimNextDueMail(db, clock())
    if (!mail) break
    let next: AfterAttempt
    try {
      let attempt: Attempt
      try {
        attempt = await attemptQueuedMail(db, mail, deps)
      } catch (err) {
        // Not a delivery answer (the database, a bug): leave the email for a later try.
        attempt = { sent: false, message: getErrorMessage(err, 'Delivery failed'), retry: 'later' }
      }
      next = await settleQueuedMail(db, mail, attempt, deps)
    } catch (err) {
      // The outcome could not be recorded. Give the claim back now rather
      // than leave the row to the stale-claim sweep, and stop: whatever
      // broke will break the next email too.
      console.error('[mail] an attempt could not be recorded:', getErrorMessage(err, 'unknown error'))
      await releaseMailClaim(db, mail.id).catch(() => {
        // The database is unreachable; the stale-claim sweep frees the row later.
      })
      break
    }
    if (next === 'stop') break
    const pace = deps.paceMs ?? PACE_MS
    if (pace > 0) await new Promise((resolve) => setTimeout(resolve, pace))
  }
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

/** Send what was just queued, or what a repaired connector can now take, without waiting for the next tick. */
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
