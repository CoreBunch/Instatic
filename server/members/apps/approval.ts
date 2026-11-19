/**
 * The member's answer to an app that wants to sign them in, given on the
 * page the owner built for it. Either way the browser goes back to the
 * app's own address: with a one-time code on approval, with `access_denied`
 * on refusal.
 */
import { MEMBER_APP_SCOPE_TEXT } from '@core/members'
import type { MemberAppRequestFrame } from '@core/templates'
import type { DbClient } from '../../db/client'
import { oauthRedirect, isLoopbackHostname } from '../../oauth/protocol'
import { recordMemberEvent } from '../repository'
import type { MemberActionContext, MemberOutcome, SignedInMember } from '../service'
import { parseMemberAppScope } from './protocol'
import { decideMemberAppRequest, findPendingMemberAppRequest } from './store'

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
  const decided = await decideMemberAppRequest(ctx.db, {
    requestId: input.requestId,
    browserMarker: input.browserMarker,
    memberId: current.member.id,
    approve: input.decision === 'allow',
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
      appRedirect: oauthRedirect(request.redirectUri, {
        error: 'access_denied',
        error_description: 'The member did not allow the app to sign in.',
        state,
        iss: request.resource,
      }),
    }
  }
  await recordMemberEvent(ctx.db, current.member.id, 'app_connected', ctx, { app: request.appName })
  return {
    ok: true,
    code: 'app_approved',
    appRedirect: oauthRedirect(request.redirectUri, { code, state, iss: request.resource }),
  }
}

/** The request a page was opened with, while it is still waiting for its answer. */
export interface PendingAppRequestOnPage {
  /** The request id, exactly as issued: it matched a stored request. */
  requestId: string
  frame: MemberAppRequestFrame
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
      access: (parseMemberAppScope(request.scope) ?? []).map((scope) => MEMBER_APP_SCOPE_TEXT[scope]).join(', '),
      returnsTo: isLoopbackHostname(host) ? 'this device' : host,
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
