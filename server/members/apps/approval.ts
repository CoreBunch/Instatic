/**
 * The member's answer to an app that wants to sign them in, given on the
 * page the owner built for it. Either way the browser goes back to the
 * app's own address: with a one-time code on approval, with `access_denied`
 * on refusal.
 */
import type { MemberAppRequestFrame } from '@core/templates'
import type { DbClient } from '../../db/client'
import { oauthRedirect, isLoopbackHostname } from '../../oauth/protocol'
import { recordMemberEvent } from '../repository'
import type { MemberActionContext, MemberOutcome, SignedInMember } from '../service'
import { parseMemberAppScope } from './protocol'
import { isAvailableMemberAppScope, memberAppScopeText } from './scopes'
import { queueMemberMail } from '../mail'
import { decideMemberAppRequest, findMemberApp, findPendingMemberAppRequest, revokeMemberAppGrant } from './store'

export async function answerAppSignIn(
  ctx: MemberActionContext,
  current: SignedInMember,
  input: { requestId: string; browserMarker: string | null; decision: string },
): Promise<MemberOutcome> {
  // The answer is the button that was pressed. Without it there is no answer,
  // and no answer is never an approval.
  if (input.decision !== 'allow' && input.decision !== 'deny') {
    return { ok: false, code: 'invalid_input', field: 'decision' }
  }
  if (!input.requestId || !input.browserMarker) return { ok: false, code: 'invalid_token' }
  // What was on offer when the app asked may be gone by the time the member
  // answers: a plugin removed, or a scope taken off the app. An approval
  // counts only for what is still on offer now.
  const stillOffered = input.decision === 'allow' && (await requestIsStillOffered(ctx.db, input.requestId))
  const decided = await decideMemberAppRequest(ctx.db, {
    requestId: input.requestId,
    browserMarker: input.browserMarker,
    memberId: current.member.id,
    approve: stillOffered,
  })
  // Answered already, run out, never issued, or opened in another browser:
  // there is no app to go back to.
  if (!decided) return { ok: false, code: 'invalid_token' }

  const { request, code } = decided
  const state = request.state ?? undefined
  if (!code) {
    return {
      ok: true,
      code: 'app_refused',
      appRedirect: oauthRedirect(request.redirectUri, input.decision === 'allow'
        ? { error: 'invalid_scope', error_description: 'The app asked for access this site no longer offers.', state, iss: request.resource }
        : { error: 'access_denied', error_description: 'The member did not allow the app to sign in.', state, iss: request.resource }),
    }
  }
  await recordMemberEvent(ctx.db, current.member.id, 'app_connected', ctx, { app: request.appName })
  // A sign-in the member did not make is one they should hear about.
  queueMemberMail(ctx.db, { kind: 'app_connected', to: current.member.email, appName: request.appName })
  return {
    ok: true,
    code: 'app_approved',
    appRedirect: oauthRedirect(request.redirectUri, { code, state, iss: request.resource }),
  }
}

/** Every scope a waiting request names is still one the app may ask for and the site offers. */
async function requestIsStillOffered(db: DbClient, requestId: string): Promise<boolean> {
  const request = await findPendingMemberAppRequest(db, requestId)
  const app = request ? await findMemberApp(db, request.appId) : null
  if (!request || !app) return false
  return (parseMemberAppScope(request.scope) ?? []).every(
    (scope) => app.scopes.includes(scope) && isAvailableMemberAppScope(scope),
  )
}

/** The request a page was opened with, while it is still waiting for its answer. */
export interface PendingAppRequestOnPage {
  /** The request id, exactly as issued: it matched a stored request. */
  requestId: string
  frame: MemberAppRequestFrame
}

/**
 * A member disconnects one of their apps, from the list on a page the owner
 * built. `connection` is the approval's id, as the list gave it.
 */
export async function disconnectApp(
  ctx: MemberActionContext,
  current: SignedInMember,
  input: { connection: string },
): Promise<MemberOutcome> {
  if (!input.connection) return { ok: false, code: 'invalid_input', field: 'connection' }
  const revoked = await revokeMemberAppGrant(ctx.db, current.member.id, input.connection)
  // Not theirs, or already gone: either way it is not connected, which is
  // what they asked for. Say so only when something was actually ended.
  if (revoked) await recordMemberEvent(ctx.db, current.member.id, 'app_disconnected', ctx, { app: revoked.appName })
  return { ok: true, code: 'updated' }
}

/**
 * The request named in the page's address, read from the stored row. Null
 * when the address names none, or one that was answered or has run out.
 */
export async function pendingAppRequestOnPage(
  db: DbClient,
  pageUrl: URL | undefined,
): Promise<PendingAppRequestOnPage | null> {
  const requestId = pageUrl?.searchParams.get('request')
  if (!requestId) return null
  const request = await findPendingMemberAppRequest(db, requestId)
  if (!request) return null
  const host = new URL(request.redirectUri).hostname
  return {
    requestId,
    frame: {
      name: request.appName,
      access: (parseMemberAppScope(request.scope) ?? []).map(memberAppScopeText).join(', '),
      returnsTo: isLoopbackHostname(host) ? 'this device' : host,
      device: request.deviceName ?? '',
    },
  }
}

/**
 * What the approval page shows about the app that sent the member there.
 * The values come from the stored request, never from the address itself.
 */
export async function memberAppRequestFrame(
  db: DbClient,
  pageUrl: URL | undefined,
): Promise<MemberAppRequestFrame | null> {
  return (await pendingAppRequestOnPage(db, pageUrl))?.frame ?? null
}

/** The hidden field an approval form posts the request back in, as `base.form` emits it. */
const REQUEST_FIELD_PATTERN = /<input\b(?=[^>]*\bdata-instatic-member-link-param="request")[^>]*>/g

/**
 * Write a waiting request's id into the approval form of a page rendered for
 * one member, so the form posts it back without the runtime script. Module
 * render functions never see the request, so this is a step after the
 * render, like `stampFormPageTokens`.
 */
export function stampAppRequestId(html: string, requestId: string): string {
  // Issued ids are base64url; anything else is not written into markup.
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) return html
  return html.replace(REQUEST_FIELD_PATTERN, (tag) =>
    /\bvalue=/.test(tag) ? tag : `${tag.slice(0, -1)} value="${requestId}">`,
  )
}
