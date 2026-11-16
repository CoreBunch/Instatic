/**
 * Account emails for members: the wording, the links, and sending them
 * without making the request wait.
 *
 * Two rules protect the people these go to:
 *
 *  - Links are built from the configured public origin, never from the
 *    request's `Host` header, so a forged Host cannot aim a reset link at
 *    someone else's server. Without a configured origin, links are only
 *    built for a loopback request (local development).
 *  - Sending happens after the response is decided, in the background, so a
 *    request for a known address takes the same time as one for an unknown
 *    address.
 */
import type { DbClient } from '../db/client'
import type { MemberPages } from '@core/members'
import { getErrorMessage } from '@core/utils/errorMessage'
import { clientIp, configuredPublicOrigin } from '../auth/security'
import { getMailAccountView } from '../mail/settings'
import { mailDeliveryMode, sendSiteMail, type SiteMail } from '../mail/send'
import type { MemberTokenKind } from './tokens'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** The origin links in emails use, or null when none can be trusted. */
export function memberLinkOrigin(req: Request): string | null {
  const configured = configuredPublicOrigin()
  if (configured) return configured
  // No configured origin: only a request that really came from this machine
  // may use its own address. A remote caller sending `Host: localhost` must
  // not get links built at all.
  const peer = clientIp(req)
  if (peer !== null && !LOOPBACK_PEERS.has(peer)) return null
  const url = new URL(req.url)
  return LOOPBACK_HOSTS.has(url.hostname) ? url.origin : null
}

/** Can this server get an email with a link to a member right now? */
export async function memberMailAvailable(db: DbClient, req: Request): Promise<boolean> {
  if (!memberLinkOrigin(req)) return false
  return mailDeliveryMode((await getMailAccountView(db)) !== null) !== 'off'
}

const PAGE_FOR_KIND: Record<MemberTokenKind, keyof MemberPages> = {
  verify: 'verify',
  reset: 'reset',
  magic: 'magic',
  invite: 'invite',
  email_change: 'emailChange',
}

/** Path of the bare core page a link opens when the owner assigned none. */
export const MEMBER_LINK_PATH_PREFIX = '/_instatic/members/link/'

export function memberTokenLink(
  origin: string,
  pages: MemberPages,
  kind: MemberTokenKind,
  token: string,
): string {
  const path = pages[PAGE_FOR_KIND[kind]] ?? `${MEMBER_LINK_PATH_PREFIX}${kind}`
  const url = new URL(path, origin)
  url.searchParams.set('token', token)
  return url.toString()
}

type MemberMailKind =
  | 'verify'
  | 'already_registered'
  | 'reset'
  | 'magic'
  | 'invite'
  | 'email_change'
  | 'email_change_notice'
  | 'password_changed'

interface MemberMailInput {
  kind: MemberMailKind
  to: string
  siteName: string
  /** The action link; absent for pure notices. */
  link?: string
  /** Extra detail for notices (the new address, for an email change). */
  detail?: string
}

const COPY: Record<MemberMailKind, { subject: string; lines: string[]; linkLabel?: string }> = {
  verify: {
    subject: 'Confirm your email address',
    lines: ['Confirm your email address to finish creating your account.'],
    linkLabel: 'This link works once and expires in 24 hours:',
  },
  already_registered: {
    subject: 'You already have an account',
    lines: [
      'Someone tried to create an account with this email address, but one already exists.',
      'If that was you, sign in instead, or reset your password if you have forgotten it.',
      'If it was not you, you can ignore this email. Nothing has changed.',
    ],
  },
  reset: {
    subject: 'Reset your password',
    lines: ['Use the link below to choose a new password.'],
    linkLabel: 'This link works once and expires in 1 hour:',
  },
  magic: {
    subject: 'Your sign-in link',
    lines: ['Use the link below to sign in.'],
    linkLabel: 'This link works once and expires in 15 minutes:',
  },
  invite: {
    subject: 'You have been invited',
    lines: ['You have been invited to create an account. Use the link below to choose a password.'],
    linkLabel: 'This link works once and expires in 7 days:',
  },
  email_change: {
    subject: 'Confirm your new email address',
    lines: ['Confirm this address to use it for your account.'],
    linkLabel: 'This link works once and expires in 1 hour:',
  },
  email_change_notice: {
    subject: 'A change to your email address was requested',
    lines: [
      'Someone signed in to your account asked to change its email address.',
      'If that was not you, change your password now.',
    ],
  },
  password_changed: {
    subject: 'Your password was changed',
    lines: [
      'The password for your account was just changed.',
      'If that was not you, reset your password now.',
    ],
  },
}

const IGNORE_LINE = 'If you did not ask for this, you can ignore this email.'

export function buildMemberMail(input: MemberMailInput): SiteMail {
  const copy = COPY[input.kind]
  const siteName = input.siteName.replace(/[\r\n]+/g, ' ').trim() || 'this site'
  const lines = [...copy.lines]
  if (input.detail) lines.push(input.detail)
  if (input.link && copy.linkLabel) {
    lines.push(copy.linkLabel, input.link, IGNORE_LINE)
  }
  return {
    kind: `member.${input.kind}`,
    to: input.to,
    subject: `${copy.subject} (${siteName})`,
    text: `${lines.join('\n\n')}\n\n${siteName}\n`,
  }
}

const pending = new Set<Promise<void>>()

/**
 * Send in the background. The caller has already decided its response, so a
 * slow or failing SMTP server never changes what, or how fast, the visitor
 * is told. Failures land in the delivery log (`sendSiteMail` records them).
 */
export function queueMemberMail(db: DbClient, input: MemberMailInput): void {
  const task = sendSiteMail(db, buildMemberMail(input))
    .then(() => undefined)
    .catch((err: unknown) => {
      console.error(`[members] ${input.kind} email was not sent:`, getErrorMessage(err, 'unknown error'))
    })
    .finally(() => {
      pending.delete(task)
    })
  pending.add(task)
}

/** Test seam: wait for every queued email to finish. */
export async function flushMemberMail(): Promise<void> {
  await Promise.all([...pending])
}
