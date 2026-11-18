/**
 * Account emails for members: the links, and sending them without making
 * the request wait. The wording lives in `mailTemplates.ts` and can be
 * edited in the Email workspace.
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
import { getMailDefaults } from '../mail/defaults'
import { mailDeliveryMode, sendTemplateMail } from '../mail/send'
import { MEMBER_MAIL_KEYS, type MemberMailKind } from './mailTemplates'
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
  return mailDeliveryMode(await getMailDefaults(db)) !== 'off'
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

interface MemberMailInput {
  kind: MemberMailKind
  to: string
  /** The action link; absent for pure notices. */
  link?: string
}

const pending = new Set<Promise<void>>()

/**
 * Send in the background. The caller has already decided its response, so a
 * slow or failing SMTP server never changes what, or how fast, the visitor
 * is told. Failures land in the mail activity log.
 */
export function queueMemberMail(db: DbClient, input: MemberMailInput): void {
  const task = sendTemplateMail(db, {
    key: MEMBER_MAIL_KEYS[input.kind],
    to: input.to,
    variables: { 'member.email': input.to, ...(input.link ? { link: input.link } : {}) },
  })
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
