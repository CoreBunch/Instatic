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
  input: { requestId: string; browserMarker: string | null; approve: boolean },
): Promise<MemberOutcome> {
  if (!input.requestId || !input.browserMarker) return { ok: false, code: 'invalid_token' }
  const decided = await decideMemberAppRequest(ctx.db, {
    requestId: input.requestId,
    browserMarker: input.browserMarker,
    memberId: current.member.id,
    approve: input.approve,
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

/**
 * What the approval page shows about the app that sent the member there: the
 * request named in the page's address, read from the stored row. Null when
 * the address names none, or one that was answered or has run out.
 */
export async function memberAppRequestFrame(
  db: DbClient,
  pageUrl: URL | undefined,
): Promise<MemberAppRequestFrame | null> {
  const requestId = pageUrl?.searchParams.get('request')
  if (!requestId) return null
  const request = await findPendingMemberAppRequest(db, requestId)
  if (!request) return null
  const host = new URL(request.redirectUri).hostname
  return {
    name: request.appName,
    access: (parseMemberAppScope(request.scope) ?? []).map((scope) => MEMBER_APP_SCOPE_TEXT[scope]).join(', '),
    returnsTo: isLoopbackHostname(host) ? 'this device' : host,
  }
}
