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
 *  - **A broken connector trips a breaker, it does not retry everything.**
 *    When the provider refuses the account itself (a wrong key or
 *    password), queued email is held and the connector shows the error.
 *    Every two minutes one email is let through as a probe; the first that
 *    gets through, or a new secret, or a test send that works, resumes
 *    delivery. No one has to remember to switch it back on.
 *  - **An accepted email is not sent twice by a failed record.** The row is
 *    marked accepted before the outcome is recorded; a marked row is never
 *    handed to a provider again.
 *  - **Core mail first, new mail before retries.** See `claimNextDueMail`.
 */
import { announceOutcome, type MailFailureReason } from './outcomes'
import type { DbClient } from '../db/client'
import { getMailTemplateDefinition } from '@core/mail'
import { getErrorMessage } from '@core/utils/errorMessage'
import { CORE_MAIL_SOURCE, markMailSent, recordMail, updateMailProgress } from './activity'
import { connectorPauseReason, pauseConnectorDelivery, takeConnectorProbe } from './connectors'
import { pluginMailTemplateDefinitions } from '@core/plugins/manifestMail'
import { getInstalledPlugin } from '../repositories/plugins'
import { findMemberById } from '../members/repository'
import { getMailDefaults } from './defaults'
import { releaseBacklogSlot, reserveBacklogSlot, reserveRecipientSlot } from './limits'
import {
  backOffQueuedMail,
  claimExpiredMail,
  claimNextDueMail,
  claimProbeMail,
  hasDueMail,
  markQueuedMailSuspect,
  DELIVERY_MARGIN_MS,
  encryptQueuedVariables,
  enqueueMail,
  holdQueuedMail,
  listAcceptedMail,
  listQueuedMailBy,
  markQueuedMailAccepted,
  QueuedMailUnreadableError,
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
  MailTemplateInvalidError,
  MailVariableMissingError,
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
  /** Who asks: omitted for the core's own mail, a plugin's id otherwise. */
  source?: string
  /** The asking plugin's name, kept in the activity log. */
  sourceLabel?: string
  /** The sender's own name for this email, handed back with the outcome. */
  reference?: string
  /**
   * The site member the email is for, when the sender named a member and
   * the host looked the address up. The outcome then names the member, never
   * the address: a sender that was not given the address does not learn it.
   */
  memberId?: string
  /** The sending plugin's install; its outcome is told to that install only. */
  installId?: string
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
  const log = {
    kind: mail.kind,
    to: mail.to,
    subject: mail.subject,
    source: input.source,
    sourceLabel: input.sourceLabel,
  }
  // A plugin's email takes its places in that plugin's limits inside the
  // transaction that accepts it, so a refusal or a failure gives them back.
  const limited = input.source !== undefined && input.source !== CORE_MAIL_SOURCE ? input.source : null
  // Counted under the name the sender used. A member and an address are
  // separate counts even when they are the same inbox: a shared count would
  // tell the sender which address a member has.
  const recipient = input.memberId !== undefined ? { member: input.memberId } : { address: input.to }
  const defaults = await getMailDefaults(db)
  if (!readyToSend(defaults)) {
    if (!captureAllowed(deps.env ?? process.env)) throw new MailNotConfiguredError()
    await db.transaction(async (tx) => {
      if (limited) await reserveRecipientSlot(tx, limited, recipient)
      await recordMail(tx, { ...log, status: 'captured', body: mail.text, error: mail.note })
    })
    return 'captured'
  }
  // An email accepted while delivery is paused says so from the start,
  // rather than looking as if it were about to leave.
  const paused = await connectorPauseReason(db, defaults.defaultConnectorId)
  const waitingFor = paused === null ? undefined : pausedMailMessage(paused)
  // Encrypted before the transaction opens: see `encryptQueuedVariables`.
  const payload = await encryptQueuedVariables(input.variables)
  const deliverBefore = input.deliverBefore ?? Date.now() + MAIL_DELIVERY_WINDOW_MS
  // One transaction: the log never shows a waiting email the queue does not hold.
  await db.transaction(async (tx) => {
    if (limited) {
      await reserveRecipientSlot(tx, limited, recipient)
      await reserveBacklogSlot(tx, limited)
    }
    const outboxId = await recordMail(tx, { ...log, status: 'queued', error: waitingFor })
    await enqueueMail(tx, {
      outboxId,
      kind: input.key,
      to: input.to,
      payload,
      deliverBefore,
      source: input.source,
      reference: input.reference,
      memberId: input.memberId,
      installId: input.installId,
    })
  })
  wakeMailQueue()
  return 'queued'
}

/** What the activity log says of an email accepted while its connector is paused. */
export function pausedMailMessage(reason: string): string {
  return `Waiting: the connector is paused. ${reason}`
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
  | { sent: true; outcome: Extract<CarryOutcome, { ok: true }>; note?: string }
  | {
      sent: false
      /** The sentence for the activity log. */
      message: string
      retry: MailRetry
      /** What the sender is told when this attempt is the email's last. */
      reason: MailFailureReason
      /** The connector to pause, when the failure was a connector's. */
      connectorId?: string
      outcome?: Extract<CarryOutcome, { ok: false }>
    }

/** Whether the plugin that queued `mail` is installed and its manifest still has the template. */
async function senderStillDeclares(db: DbClient, mail: QueuedMail): Promise<boolean> {
  const sender = await getInstalledPlugin(db, mail.source)
  if (!sender) return false
  // A manifest that cannot be read just now says nothing about the template.
  if (sender.kind !== 'ok') return true
  return pluginMailTemplateDefinitions(sender.plugin.manifest).some((definition) => definition.key === mail.kind)
}

/**
 * How long before the delivery margin the last try is due. The worker looks
 * every `TICK_INTERVAL_MS`, so the try must stay claimable for longer than
 * one interval whatever the phase of the tick: two intervals, one to be
 * found in and one of headroom for a drain that is busy with a slow send.
 */
const LAST_TRY_LEAD_MS = 2 * TICK_INTERVAL_MS

/** How many emails one probe of a paused connector may try. */
const PROBE_CANDIDATES = 3

/** The provider judged this email or its recipient, plainly: not the account, and not ambiguously. */
function refusedForItsOwnReasons(attempt: Attempt): boolean {
  return !attempt.sent && !attempt.outcome?.suspect && attempt.retry === 'never'
}

/** Try one queued email once. */
async function attemptQueuedMail(db: DbClient, mail: QueuedMail, deps: DrainDeps): Promise<Attempt> {
  let variables: Record<string, string>
  try {
    variables = await readQueuedVariables(mail)
  } catch (err) {
    // Only a failed decryption means the values, and the links in them, are
    // gone for good. Anything else may pass.
    if (err instanceof QueuedMailUnreadableError) {
      return { sent: false, message: err.message, retry: 'never', reason: 'unreadable' }
    }
    throw err
  }
  if (mail.memberId !== null) {
    // Accepted for a member who has since been suspended or deleted: they
    // are not written to any more, whatever was queued for them.
    const member = await findMemberById(db, mail.memberId)
    if (!member || member.status !== 'active') {
      return {
        sent: false,
        message: 'The member this email was for has been suspended or deleted.',
        retry: 'never',
        reason: 'recipient_unavailable',
      }
    }
  }
  const defaults = await getMailDefaults(db)
  if (!readyToSend(defaults)) {
    return { sent: false, message: new MailNotConfiguredError().message, retry: 'connector', reason: 'expired' }
  }
  if (!getMailTemplateDefinition(mail.kind)) {
    // A plugin's templates are in the catalogue only while it is enabled. If
    // the plugin is still installed and still declares this template (it is
    // disabled, being upgraded or restarting), the email waits for it. The
    // template is gone for good only when the plugin is, or when an upgrade
    // dropped it.
    if (mail.source !== CORE_MAIL_SOURCE && (await senderStillDeclares(db, mail))) {
      return {
        sent: false,
        message: 'Waiting: the plugin that sends this email is not active.',
        retry: 'later',
        reason: 'expired',
      }
    }
    return {
      sent: false,
      message: 'The template of this email no longer exists: its plugin was removed or no longer declares it.',
      retry: 'never',
      reason: 'template_removed',
    }
  }
  let rendered
  try {
    rendered = await buildTemplateMail(db, { key: mail.kind, to: mail.to, variables }, 'deliver')
    assertSendable(rendered)
  } catch (err) {
    // The template no longer renders a sendable message. Another try would
    // end the same way, and nothing is sent with a variable left in it.
    return {
      sent: false,
      message: getErrorMessage(err, 'The email could not be prepared.'),
      retry: 'never',
      reason:
        err instanceof MailTemplateInvalidError || err instanceof MailVariableMissingError
          ? 'template_invalid'
          : 'template_removed',
    }
  }
  const outcome = await carryThroughConnector(
    db,
    defaults.defaultConnectorId,
    defaults,
    rendered,
    deps.carrier,
    (deps.now ?? Date.now)(),
    !mail.suspect,
  )
  if (outcome.ok) return { sent: true, outcome, note: rendered.note }
  return {
    sent: false,
    message: outcome.message,
    retry: outcome.retry,
    // A refusal that is not final only ever ends the email by running out its time.
    reason: outcome.retry === 'never' ? 'recipient_rejected' : 'expired',
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
    // First, and on its own: from here on this row is never sent again,
    // whatever becomes of the two writes below.
    await markQueuedMailAccepted(db, mail.id)
    await updateMailProgress(db, mail.outboxId, {
      status: 'sent',
      attempts: mail.attempts + 1,
      connector: attempt.outcome.connector,
      providerMessageId: attempt.outcome.providerMessageId,
      durationMs: attempt.outcome.durationMs,
      // Not an error: what the owner should know about this email (see `SiteMail.note`).
      error: attempt.note,
    })
    await removeQueuedMail(db, mail)
    announceOutcome(db, mail, 'sent', null)
    return 'continue'
  }
  const seen = { connector: attempt.outcome?.connector, error: attempt.message, durationMs: attempt.outcome?.durationMs }
  if (attempt.outcome?.suspect) await markQueuedMailSuspect(db, mail.id, now)

  if (attempt.retry === 'connector') {
    // Not this email's failure, so no attempt is counted against it and it
    // is due the moment delivery resumes. The activity log shows the reason
    // now, not after a day of silent retries.
    const held = await holdQueuedMail(db, mail.id, attempt.message)
    await updateMailProgress(
      db,
      mail.outboxId,
      held
        ? { ...seen, status: 'queued', attempts: mail.attempts }
        : { ...seen, status: 'failed', attempts: mail.attempts, error: REMOVED_WHILE_SENDING },
    )
    if (attempt.connectorId) await pauseConnectorDelivery(db, attempt.connectorId, now)
    console.error('[mail] delivery is paused: the connector refuses the account or is not set up')
    return 'stop'
  }

  const attempts = mail.attempts + 1
  if (attempt.retry === 'slow-down') pausedUntil = now + SLOW_DOWN_PAUSE_MS
  const delay = mailRetryDelayMs(attempts, (deps.random ?? Math.random)())
  if (attempt.retry === 'never') {
    await updateMailProgress(db, mail.outboxId, { ...seen, attempts, status: 'failed' })
    await removeQueuedMail(db, mail)
    console.error(`[mail] gave up on a "${mail.kind}" email after ${attempts} attempt(s)`)
    announceOutcome(db, mail, 'failed', attempt.reason)
    return 'continue'
  }
  // The last moment a try is still of use. A wait that would run past it is
  // cut short to it, so the email gets its last try; only when that moment
  // has itself passed is the email given up on.
  const lastChance = mail.deliverBefore - DELIVERY_MARGIN_MS - LAST_TRY_LEAD_MS
  if (lastChance <= now) {
    await failExpiredMail(db, mail, { attempts, lastError: attempt.message, connector: seen.connector })
    return 'continue'
  }
  const nextAttemptAt = new Date(Math.min(now + delay, lastChance)).toISOString()
  // The queue first: a row that was removed meanwhile (its sender uninstalled,
  // its member deleted) must not leave the log saying "waiting" for ever.
  const put = await rescheduleQueuedMail(db, mail.id, { attempts, nextAttemptAt, error: attempt.message })
  await updateMailProgress(
    db,
    mail.outboxId,
    put
      ? { ...seen, attempts, status: 'queued', nextAttemptAt }
      : { ...seen, attempts, status: 'failed', error: REMOVED_WHILE_SENDING },
  )
  return attempt.retry === 'slow-down' ? 'stop' : 'continue'
}

const REMOVED_WHILE_SENDING = 'Removed from the queue while it was being sent.'

/**
 * Take every queued email matching `column = value` out of the queue and log
 * it as failed with `error`: an uninstalled plugin's email, or a deleted
 * member's. One transaction, so the queue, the backlog counts and the log
 * agree. An email a worker has claimed (it is being handed over at this
 * moment) is left to that worker: it is logged as what really became of it,
 * and if it comes back for another try that try ends it, because its
 * template or its member is gone.
 */
export async function discardQueuedMail(
  db: DbClient,
  column: 'source' | 'member_id',
  value: string,
  error: string,
  reason: MailFailureReason | null,
): Promise<void> {
  const discarded = await db.transaction(async (tx) => {
    const removed: QueuedMail[] = []
    for (const mail of await listQueuedMailBy(tx, column, value)) {
      const gone = await tx`delete from mail_queue where id = ${mail.id} and accepted_at is null and claimed_at is null`
      if (gone.rowCount === 0) continue
      if (mail.source !== CORE_MAIL_SOURCE) await releaseBacklogSlot(tx, mail.source)
      await updateMailProgress(tx, mail.outboxId, { status: 'failed', attempts: mail.attempts, error })
      removed.push(mail)
    }
    return removed
  })
  if (reason !== null) for (const mail of discarded) announceOutcome(db, mail, 'failed', reason)
}

/** A deleted member is not written to: what was queued for them is dropped. */
export async function discardQueuedMailForMember(db: DbClient, memberId: string): Promise<void> {
  await discardQueuedMail(
    db,
    'member_id',
    memberId,
    'The member this email was for was deleted before it was sent.',
    'recipient_unavailable',
  )
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
  await removeQueuedMail(db, mail)
  console.error(`[mail] a "${mail.kind}" email expired before it could be delivered`)
  announceOutcome(db, mail, 'failed', 'expired')
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
 * Emails a provider accepted whose acceptance could not be written to the
 * database at all. They are not sent again by this process; the bookkeeping
 * is finished the next time the row comes up.
 */
const acceptedUnrecorded = new Set<string>()
/** How often in a row the outcome of an attempt could not be recorded, per email. */
const unrecordedAttempts = new Map<string, number>()

/** Finish the bookkeeping of emails that were accepted but not recorded. */
async function finishAcceptedMail(db: DbClient): Promise<void> {
  for (const row of await listAcceptedMail(db)) {
    try {
      await markMailSent(db, row.outboxId, row.attempts + 1)
      await removeQueuedMail(db, row)
      // The sender hears of it now: the pass that sent it never got this far.
      announceOutcome(db, row, 'sent', null)
      acceptedUnrecorded.delete(row.id)
      unrecordedAttempts.delete(row.id)
    } catch (err) {
      // Still not recordable. The row stays marked, so it is not sent, and
      // the rest of the queue is not held up by it.
      console.error('[mail] an accepted email could not be recorded yet:', getErrorMessage(err, 'unknown error'))
    }
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
  await finishAcceptedMail(db)
  // Expired email is failed even while nothing can be sent.
  await expireOverdueMail(db, clock())

  // A paused connector lets an email through now and then, as a probe. The
  // turn is only taken when there is something to probe with.
  const defaults = await getMailDefaults(db)
  let probesLeft = 0
  if (readyToSend(defaults) && (await connectorPauseReason(db, defaults.defaultConnectorId)) !== null) {
    if (!(await hasDueMail(db, clock()))) return
    const gate = await takeConnectorProbe(db, defaults.defaultConnectorId, clock())
    if (gate === 'held') return
    if (gate === 'probe') probesLeft = PROBE_CANDIDATES
  }
  const probed: string[] = []

  while (!stopping && clock() >= pausedUntil) {
    const mail = probesLeft > 0 ? await claimProbeMail(db, clock(), probed) : await claimNextDueMail(db, clock())
    if (!mail) break
    let next: AfterAttempt
    let accepted = acceptedUnrecorded.has(mail.id)
    let attempt: Attempt
    try {
      if (accepted) {
        // The provider already has this one: record it, do not send it.
        await markQueuedMailAccepted(db, mail.id)
        await finishAcceptedMail(db)
        continue
      }
      try {
        attempt = await attemptQueuedMail(db, mail, deps)
      } catch (err) {
        // Not a delivery answer (the database, a bug): leave the email for a later try.
        attempt = { sent: false, message: getErrorMessage(err, 'Delivery failed'), retry: 'later', reason: 'expired' }
      }
      accepted = attempt.sent
      next = await settleQueuedMail(db, mail, attempt, deps)
      unrecordedAttempts.delete(mail.id)
    } catch (err) {
      // The outcome could not be recorded. If the provider took the email,
      // this process must not send it again; either way the row is put back
      // with a growing wait rather than tried again on every pass. Then
      // stop: whatever broke will break the next email too.
      console.error('[mail] an attempt could not be recorded:', getErrorMessage(err, 'unknown error'))
      if (accepted) acceptedUnrecorded.add(mail.id)
      const failures = (unrecordedAttempts.get(mail.id) ?? 0) + 1
      unrecordedAttempts.set(mail.id, failures)
      const retryAt = new Date(clock() + mailRetryDelayMs(failures, (deps.random ?? Math.random)())).toISOString()
      await backOffQueuedMail(db, mail.id, retryAt).catch(() => {
        // The database is unreachable; the stale-claim sweep frees the row later.
      })
      break
    }
    if (probesLeft > 0) {
      if (accepted) {
        // The connector works again (`noteConnectorUse` lifted the pause).
        probesLeft = 0
      } else {
        // An email refused for its recipient's own reasons says nothing about
        // the connector: the next candidate gets this turn, a few at most.
        // Any other answer leaves the connector paused until the next turn.
        probed.push(mail.id)
        probesLeft -= 1
        if (probesLeft === 0 || !refusedForItsOwnReasons(attempt)) break
        continue
      }
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
  acceptedUnrecorded.clear()
  unrecordedAttempts.clear()
}
