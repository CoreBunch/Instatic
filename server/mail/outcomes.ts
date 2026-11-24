/**
 * What became of a queued email, told to whoever asked for it. The queue
 * (`delivery.ts`) announces; the plugin host listens and passes the news on
 * to the plugin that queued the email.
 */
import { getErrorMessage } from '@core/utils/errorMessage'
import type { DbClient } from '../db/client'
import { CORE_MAIL_SOURCE } from './activity'
import type { QueuedMail } from './queue'

/**
 * Why a queued email was given up on, for whoever asked for it. A fixed set
 * of codes and never the provider's own words, which can quote the
 * recipient's address: the full sentence stays in the admin's activity log.
 *
 *  - `recipient_rejected`: the provider refused this message or recipient.
 *  - `expired`: its deadline passed before it could be delivered (the
 *    provider was unreachable or throttling, or the connector was broken).
 *  - `template_removed`: the template no longer exists or no longer renders.
 *  - `unreadable`: the server's secret key changed while the email waited.
 *  - `recipient_unavailable`: the member it was for was suspended or deleted
 *    before it could be sent.
 *  - `template_invalid`: the template would have gone out with a variable
 *    still in it, so it was not sent.
 */
export type MailFailureReason =
  | 'recipient_rejected'
  | 'expired'
  | 'template_removed'
  | 'template_disabled'
  | 'unreadable'
  | 'recipient_unavailable'
  | 'template_invalid'

/** What became of a queued email that was not the core's own. */
export interface QueuedMailOutcome {
  source: string
  /** The template key. */
  kind: string
  /** The recipient exactly as the sender named it. */
  recipient: { member: string } | { address: string }
  reference: string | null
  /** The install of the sending plugin that queued the email. */
  installId: string | null
  status: 'sent' | 'failed'
  /** Why it failed, as a fixed code. Null for a sent email. */
  reason: MailFailureReason | null
}

let outcomeHandler: ((db: DbClient, outcome: QueuedMailOutcome) => void) | null = null

/**
 * Hear what becomes of every queued email that has a `source` other than
 * the core. The plugin host uses this to tell a plugin about its own mail.
 */
export function setQueuedMailOutcomeHandler(handler: ((db: DbClient, outcome: QueuedMailOutcome) => void) | null): void {
  outcomeHandler = handler
}

export function announceOutcome(db: DbClient, mail: QueuedMail, status: 'sent' | 'failed', reason: MailFailureReason | null): void {
  if (mail.source === CORE_MAIL_SOURCE || !outcomeHandler) return
  try {
    outcomeHandler(db, {
      source: mail.source,
      kind: mail.kind,
      recipient: mail.memberId !== null ? { member: mail.memberId } : { address: mail.to },
      reference: mail.reference,
      installId: mail.installId,
      status,
      reason,
    })
  } catch (err) {
    console.error('[mail] outcome handler threw:', getErrorMessage(err, 'unknown error'))
  }
}
