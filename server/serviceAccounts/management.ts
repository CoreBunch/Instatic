import { ApproveServiceSchema, ExchangeServiceSchema, RenewServiceAccountSchema, ServiceAccountInputSchema } from '@core/serviceAccounts'
import type { DbClient } from '../db/client'
import { requireCapability, requireStepUp, capabilitiesUserCannotGrant } from '../auth/authz'
import { jsonResponse, badRequest, readValidatedBody, methodNotAllowed } from '../http'
import { oauthIssuerOrigin } from '../oauth/protocol'
import { createAuditEvent } from '../repositories/audit'
import { listAccounts, createAccount, issueCode, exchangeCode, renewExpiredAccount, revokeAccount } from './store'
import { recentServiceActivity } from './activity'
import { cliFilename, cliPackageResponse } from './package'

const SERVICE_BASE = '/admin/api/cms/service-accounts'
export async function handleServiceAccounts(req: Request, db: DbClient): Promise<Response | null> {
  const path = new URL(req.url).pathname
  if (path !== SERVICE_BASE && !path.startsWith(SERVICE_BASE + '/')) return null
  if (path === SERVICE_BASE + '/' + cliFilename && req.method === 'GET') return cliPackageResponse()
  const issuer = oauthIssuerOrigin(req)
  const part = path.slice(SERVICE_BASE.length + 1)
  const [id, action, extra] = part.split('/')
  if (extra !== undefined || (id && !/^svc_[a-f0-9-]{36}$/.test(id))) return badRequest('Unknown service account')
  if (action === 'exchange' && req.method === 'POST') {
    const body = await readValidatedBody(req, ExchangeServiceSchema)
    if (!issuer || !body) return badRequest('Invalid connection request')
    const token = await exchangeCode(db, id, body.code, body.verifier)
    return token ? Response.json({ token }, { headers: { 'Cache-Control': 'no-store' } })
      : jsonResponse({ error: 'Approval expired or already used. Connect again.' }, { status: 401 })
  }
  const user = await requireCapability(req, db, 'ai.providers.manage')
  if (user instanceof Response) return user
  if (action === 'activity' && req.method === 'GET') return jsonResponse(await recentServiceActivity(db, user.id, id))
  if (!part && req.method === 'GET') return jsonResponse({ accounts: await listAccounts(db, user.id), origin: issuer, cliFilename })
  if (!part && req.method === 'POST') {
    if (!issuer) return badRequest('Configure PUBLIC_ORIGIN to connect a CLI')
    const body = await readValidatedBody(req, ServiceAccountInputSchema)
    if (!body || !body.label.trim()) return badRequest('Enter a name, permissions and an expiry')
    if (capabilitiesUserCannotGrant(user, body.capabilities).length) return jsonResponse({ error: 'Permission exceeds your role' }, { status: 403 })
    const step = await requireStepUp(req, db, user, { policy: 'always' })
    if (step) return step
    return db.transaction(async tx => {
      const accountId = await createAccount(tx, user.id, body)
      await createAuditEvent(tx, { actorUserId: user.id, action: 'service_account.created', targetId: accountId,
        targetType: 'service_account', metadata: { label: body.label, capabilities: body.capabilities, ttlHours: body.ttlHours } })
      return jsonResponse({ id: accountId }, { status: 201 })
    })
  }
  if (id && action === 'renew' && req.method === 'POST') {
    const body = await readValidatedBody(req, RenewServiceAccountSchema)
    if (!body) return badRequest('Choose a connection lifetime between 1 hour and 30 days')
    const step = await requireStepUp(req, db, user, { policy: 'always' })
    if (step) return step
    return db.transaction(async tx => {
      const renewal = await renewExpiredAccount(tx, id, user.id, body.ttlHours)
      if (!renewal) return jsonResponse({ error: 'No expired connection available to renew' }, { status: 409 })
      await createAuditEvent(tx, { actorUserId: user.id, action: 'service_account.renewed', targetType: 'service_account', targetId: id, metadata: renewal })
      return jsonResponse(renewal)
    })
  }
  if (id && !action && req.method === 'DELETE') {
    return db.transaction(async tx => {
      if (!await revokeAccount(tx, id, user.id)) return jsonResponse({ error: 'Active connector not found' }, { status: 404 })
      await createAuditEvent(tx, { actorUserId: user.id, action: 'service_account.revoked', targetType: 'service_account', targetId: id })
      return jsonResponse({ ok: true })
    })
  }
  if (action === 'approve' && req.method === 'POST') {
    if (!issuer) return badRequest('Configure PUBLIC_ORIGIN to connect a CLI')
    const body = await readValidatedBody(req, ApproveServiceSchema)
    if (!body) return badRequest('Invalid CLI challenge')
    const step = await requireStepUp(req, db, user, { policy: 'always' })
    if (step) return step
    return db.transaction(async tx => {
      const code = await issueCode(tx, id, user.id, body.challenge)
      if (!code) return jsonResponse({ error: 'Connector expired, revoked or unavailable' }, { status: 403 })
      await createAuditEvent(tx, { actorUserId: user.id, action: 'service_account.authorized', targetType: 'service_account', targetId: id })
      return Response.json({ code }, { headers: { 'Cache-Control': 'no-store' } })
    })
  }
  return methodNotAllowed()
}
