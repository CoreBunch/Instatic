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
 *  - Handing an email to the queue happens after the response is decided
 *    and is not awaited, so nothing about email delivery shows in how long a
 *    request takes.
 */
import type { DbClient } from '../db/client'
import type { MemberPageKey, MemberPagePaths } from '@core/members'
import type { PluginMemberEmailBlocker } from '@core/plugin-sdk'
import { getErrorMessage } from '@core/utils/errorMessage'
import { clientIp, configuredPublicOrigin } from '../auth/security'
import { getMailDefaults } from '../mail/defaults'
import { recordMail } from '../mail/activity'
import { queueTemplateMail } from '../mail/delivery'
import { mailDeliveryMode } from '../mail/send'
import { MEMBER_MAIL_KEYS, type MemberMailKind } from './mailTemplates'
import { getMemberPagePaths } from './pages'
import { TOKEN_LIFETIME_MS, type MemberTokenKind } from './tokens'

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

/**
 * Why the site cannot email a member a link it starts itself (an invitation,
 * a sign-in link). Plugins read these through `api.cms.members.emailStatus`,
 * so the SDK's list is the one list.
 */
export type MemberEmailBlocker = PluginMemberEmailBlocker

/**
 * What stands between the site and emailing members links right now, with
 * no request to take an address from (so only the configured public origin
 * counts): outgoing email that really goes out, the invitation page, and a page for a sign-in
 * link or a password reset. Empty when nothing does.
 */
export async function memberEmailBlockers(db: DbClient): Promise<MemberEmailBlocker[]> {
  const blockers: MemberEmailBlocker[] = []
  if (!configuredPublicOrigin()) blockers.push('public_address_missing')
  // Capture (no connector outside production) keeps mail in the admin's
  // Activity: nothing reaches the member, so it is not emailing them.
  const mode = mailDeliveryMode(await getMailDefaults(db))
  if (mode === 'off') blockers.push('mail_not_configured')
  if (mode === 'capture') blockers.push('mail_captured_not_sent')
  const pages = await getMemberPagePaths(db)
  if (!memberLinkPage(pages, 'invite')) blockers.push('invite_page_missing')
  if (!memberLinkPage(pages, 'magic') && !memberLinkPage(pages, 'reset')) blockers.push('sign_in_page_missing')
  return blockers
}

const PAGE_FOR_KIND: Record<MemberTokenKind, MemberPageKey> = {
  verify: 'verify',
  reset: 'reset',
  magic: 'magic',
  invite: 'invite',
  email_change: 'emailChange',
}

/**
 * The referrer policy of a page whose address holds a live link token.
 *
 * `same-origin` keeps the address out of every request to another site,
 * which is what matters. It is deliberately not `no-referrer`: under that
 * policy a browser sends `Origin: null` when the page's own form is
 * submitted, and the member endpoints, which require the site's origin on a
 * POST, would refuse the very form the page exists to submit.
 */
export const TOKEN_PAGE_REFERRER_POLICY = 'same-origin'

/**
 * The live address of the page that a link of this kind opens, or undefined
 * when the owner has not assigned one or it is not published. Core has no page of its own for any of them: a
 * link can only lead to a page the owner built, so without one the feature
 * that would send the link is not available.
 */
export function memberLinkPage(pages: MemberPagePaths, kind: MemberTokenKind): string | undefined {
  return pages[PAGE_FOR_KIND[kind]]
}

/** The link for a token, or null when no page is assigned for its kind. */
export function memberTokenLink(
  origin: string,
  pages: MemberPagePaths,
  kind: MemberTokenKind,
  token: string,
): string | null {
  const path = memberLinkPage(pages, kind)
  if (!path) return null
  const url = new URL(path, origin)
  url.searchParams.set('token', token)
  return url.toString()
}

interface MemberMailInput {
  kind: MemberMailKind
  to: string
  /** The action link; absent for pure notices. */
  link?: string
  /** The app a notice is about. */
  appName?: string
  /** An app approval link shares the deadline of its pending request. */
  deliverBefore?: number
}

const pending = new Set<Promise<void>>()

/** The kinds of email that carry a link, which stops working when its token expires. */
function isLinkKind(kind: MemberMailKind): kind is MemberTokenKind {
  return kind in TOKEN_LIFETIME_MS
}

/**
 * Queue the email without making the request wait for it. The caller has
 * already decided its response, so rendering the template and writing to
 * the queue add nothing to what, or how fast, the visitor is told. (It does
 * not make the two cases take equal time: a request for a known address has
 * already issued a token.) For the same reason the email is queued after
 * the token is committed, in its own transaction, not in the token's: if
 * that fails the member can ask again, and the failure is logged below.
 * The mail queue sends it straight away and retries
 * a temporary failure, but never past the life of the link in it: a
 * sign-in link that arrives after it expired is worse than none.
 *
 * An email that could not even be queued is not only a log line: the
 * activity log gets a failed entry, so the owner can see that a member was
 * left without their email.
 */
export function queueMemberMail(db: DbClient, input: MemberMailInput): void {
  const key = MEMBER_MAIL_KEYS[input.kind]
  // The token was issued a moment ago, so its life is counted from now.
  const deliverBefore = input.deliverBefore ?? (isLinkKind(input.kind) ? Date.now() + TOKEN_LIFETIME_MS[input.kind] : undefined)
  const task = queueTemplateMail(db, {
    key,
    to: input.to,
    variables: {
      'member.email': input.to,
      ...(input.link ? { link: input.link } : {}),
      ...(input.appName ? { 'app.name': input.appName } : {}),
    },
    deliverBefore,
  })
    .then(() => undefined)
    .catch(async (err: unknown) => {
      const reason = getErrorMessage(err, 'unknown error')
      console.error(`[members] ${input.kind} email was not queued:`, reason)
      await recordMail(db, {
        kind: key,
        to: input.to,
        subject: '(not queued)',
        status: 'failed',
        attempts: 0,
        error: `Not queued, so never sent: ${reason}`,
      }).catch((logErr: unknown) => {
        console.error('[members] the failure could not be logged either:', getErrorMessage(logErr, 'unknown error'))
      })
    })
    .finally(() => {
      pending.delete(task)
    })
  pending.add(task)
}

/**
 * Wait until every email handed over so far is in the queue. The server
 * calls this on shutdown, so a restart never drops an email between a
 * request and the queue; tests call it before they look.
 */
export async function flushMemberMail(): Promise<void> {
  await Promise.all([...pending])
}
