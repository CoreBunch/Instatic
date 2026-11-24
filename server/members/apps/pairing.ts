import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import type { ApprovalView, ApprovalState } from '@core/members'
import { getMemberPagePaths } from '../pages'
import { renderPublicResolution } from '../../publish/publicRouter'
import { clientIp, isCrossSiteFetch, isSiteOrigin } from '../../auth/security'
import type { DbClient } from '../../db/client'
import { readTextBodyWithLimit } from '../../http'
import { hasDuplicateParameters } from '../../oauth/protocol'
import { generateOpaqueToken, hashOpaqueToken } from '../../oauth/secrets'
import { privateJsonResponse } from '../../oauth/tokenEndpoint'
import { memberLimits } from '../limits'
import { memberMailAvailable, queueMemberMail } from '../mail'
import { findMemberByEmail, findMemberById, markMemberVerified, recordMemberEvent } from '../repository'
import { emailProblem, mailAllowedTo } from '../service'
import { findMemberSession, readMemberSessionToken } from '../sessions'
import { requestIsStillOffered } from './approval'
import { MEMBER_OAUTH_PATH_PREFIX, parseMemberAppScope } from './protocol'
import { memberAppScopeText } from './scopes'
import { findPendingMemberAppRequest, issueAppCode, REQUEST_TTL_MS } from './store'

export const PAIR_PATH = MEMBER_OAUTH_PATH_PREFIX + 'pair'
const approvalPath = PAIR_PATH + '/approve'

const statusFields = Type.Object({
  device_code: Type.String({ pattern: '^imem_pair_[A-Za-z0-9_-]{43}$' }),
  client_id: Type.String({ minLength: 1, maxLength: 256 }),
  action: Type.Optional(Type.Literal('cancel')),
})
const decisionFields = Type.Union([
  Type.Object({ action: Type.Literal('email'), email: Type.String() }),
  Type.Object({ action: Type.Union([Type.Literal('allow'), Type.Literal('deny')]), account: Type.String() }),
])

export async function readPairFields(req: Request): Promise<URLSearchParams | null> {
  if (req.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return null
  try {
    const fields = new URLSearchParams(await readTextBodyWithLimit(req, 8192))
    return hasDuplicateParameters(fields) ? null : fields
  } catch {
    return null // Refuse oversized and unreadable form bodies.
  }
}

export async function startPair(db: DbClient, id: string, issuer: string): Promise<Response> {
  const deviceCode = generateOpaqueToken('imem_pair_')
  const digits = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  const display = digits.slice(0, 4) + '-' + digits.slice(4)
  await db`insert into member_app_pairs (request_hash, device_hash, display_code)
    values (${await hashOpaqueToken(id)}, ${await hashOpaqueToken(deviceCode)}, ${display})`
  const approval = new URL(approvalPath, issuer)
  approval.searchParams.set('request', id)
  return privateJsonResponse({ verification_uri: approval.href, user_code: display, device_code: deviceCode, expires_in: REQUEST_TTL_MS / 1000 })
}

export async function pairingStatus(req: Request, db: DbClient): Promise<Response> {
  const fields = await readPairFields(req)
  const parsed = safeParseValue(statusFields, Object.fromEntries(fields ?? []))
  if (!parsed.ok) return privateJsonResponse({ error: 'invalid_request' }, { status: 400 })
  const hash = await hashOpaqueToken(parsed.value.device_code)
  const result = await db<{ decision: string | null }>`
    select p.decision from member_app_pairs p join member_app_requests r on p.request_hash = r.id_hash
    where p.device_hash = ${hash} and r.app_id = ${parsed.value.client_id} and r.expires_at > ${new Date().toISOString()}`
  const row = result.rows[0]
  if (row && parsed.value.action === 'cancel') {
    await db`update member_app_pairs set decision = 'denied' where device_hash = ${hash} and decision is null`
    return privateJsonResponse({ status: 'closed' })
  }
  return privateJsonResponse({ status: row ? row.decision ?? 'pending' : 'closed' })
}

export async function pairingPage(req: Request, db: DbClient, url: URL): Promise<Response> {
  const path = (await getMemberPagePaths(db)).appPair
  if (!path) return privateJsonResponse({ error: 'The site has no published device approval page.' }, { status: 503 })
  const pageUrl = new URL(path, url.origin)
  const view: ApprovalView = { state: 'closed' }
  async function screen(state: ApprovalState, status = 200, message?: string) {
    // The authored page receives presentation data only. Query credentials
    // never enter the site's route frame, shared caches or asset referrers.
    const rendered = await renderPublicResolution(db, pageUrl, undefined, undefined, { ...view, state, message })
    if (!rendered?.ok) return privateJsonResponse({ error: 'Choose a published, public device approval page.' }, { status: 503 })
    return new Response(rendered.body, { status, headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin',
      'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    } })
  }
  const closed = () => screen('closed', 410)
  const id = url.searchParams.get('request') ?? ''
  const request = await findPendingMemberAppRequest(db, id)
  if (!request) return closed()
  const hash = await hashOpaqueToken(id)
  const { rows } = await db<{ display_code: string; email_hash: string | null; email_member_id: string | null; email_address: string | null; expires_at: string | Date }>`
    select p.display_code, p.email_hash, p.email_member_id, p.email_address, r.expires_at
    from member_app_pairs p join member_app_requests r on r.id_hash = p.request_hash
    where request_hash = ${hash} and decision is null`
  const pair = rows[0]
  if (!pair) return closed()
  const token = url.searchParams.get('token')
  const tokenHash = token ? await hashOpaqueToken(token) : null
  const sessionToken = readMemberSessionToken(req)
  const session = !token && sessionToken ? await findMemberSession(db, sessionToken) : null
  const memberId = token ? (tokenHash === pair.email_hash ? pair.email_member_id : null) : session?.memberId
  const member = memberId ? await findMemberById(db, memberId) : null
  if (token && (!member || member.status !== 'active' || member.email !== pair.email_address)) return closed()
  const canApprove = member?.status === 'active' && (token || member.emailVerifiedAt)
  view.name = request.appName
  view.code = pair.display_code
  view.access = (parseMemberAppScope(request.scope) ?? []).map(memberAppScopeText).join(', ')
  view.device = request.deviceName ?? ''
  const ip = clientIp(req) ?? 'unknown'
  if (req.method === 'POST') {
    if (isCrossSiteFetch(req) || !isSiteOrigin(req, req.headers.get('origin') ?? '')) return screen('error', 403, 'Request refused')
    const fields = await readPairFields(req)
    const parsed = safeParseValue(decisionFields, Object.fromEntries(fields ?? []))
    if (!parsed.ok) return screen('error', 400, 'Invalid approval form')
    const input = parsed.value
    const action = input.action
    if (action === 'email' && !token) {
      const email = input.email
      if (emailProblem(email)) return screen('error', 400, 'Enter a valid email address')
      if (!memberLimits.mailPerIp.consume(ip).ok) return screen('error', 429, 'Try again later')
      if (!await memberMailAvailable(db, req)) return screen('error', 503, 'Email is unavailable')
      if (mailAllowedTo(email, 'app_pair')) {
        const target = await findMemberByEmail(db, email)
        if (target?.status === 'active') {
          const proof = generateOpaqueToken('imem_mail_')
          const updated = await db`update member_app_pairs set email_hash = ${await hashOpaqueToken(proof)}, email_member_id = ${target.id}, email_address = ${target.email}
            where request_hash = ${hash} and decision is null`
          const link = new URL(approvalPath, request.resource)
          link.searchParams.set('request', id)
          link.searchParams.set('token', proof)
          if (updated.rowCount) queueMemberMail(db, { kind: 'app_pair', to: target.email, appName: request.appName, link: link.href, deliverBefore: new Date(pair.expires_at).getTime() })
        }
      }
      return screen('sent')
    }
    if (!member || !canApprove || action === 'email' || input.account !== member.id) {
      return screen('error', 403, 'Reload the page to confirm the account.')
    }
    const decision = await db.transaction(async tx => {
      const approve = action === 'allow' && await requestIsStillOffered(tx, id)
      const now = new Date()
      const updated = await tx<{ device_hash: string }>`update member_app_pairs set decision = ${approve ? 'approved' : 'denied'},
          email_hash = null, email_address = null, email_member_id = null
        where request_hash = ${hash} and decision is null and (${tokenHash ?? ''} = '' or email_hash = ${tokenHash ?? ''})
          and exists (select 1 from member_app_requests where id_hash = ${hash} and decided_at is null and expires_at > ${now.toISOString()})
          and exists (select 1 from members where id = ${member.id} and status = 'active' and deleted_at is null and email = ${member.email})
        returning device_hash`
      if (!updated.rows[0]) return 'closed'
      await tx`update member_app_requests set decided_at = ${now.toISOString()} where id_hash = ${hash}`
      if (approve) {
        if (token) await markMemberVerified(tx, member.id)
        await issueAppCode(tx, request, member.id, updated.rows[0].device_hash, now)
        await recordMemberEvent(tx, member.id, 'app_connected', { ipAddress: ip, userAgent: req.headers.get('user-agent') }, { app: request.appName })
      }
      return approve ? 'approved' : 'denied'
    })
    if (decision === 'closed' || (decision === 'denied' && action === 'allow')) return closed()
    if (decision === 'approved') queueMemberMail(db, { kind: 'app_connected', to: member.email, appName: request.appName })
    return screen(decision)
  }
  if (canApprove && member) {
    view.email = member.email
    view.account = member.id
    return screen('review')
  }
  return screen('email')
}
