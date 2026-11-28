import { ADMIN_INVITE_TEMPLATE_KEY } from '@core/mail'
import { isValidEmail } from '@core/utils/email'
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT_MESSAGE } from '@core/utils/passwordPolicy'
import { Type } from '@core/utils/typeboxHelpers'
import { rejectsRoleAssignment, requireStepUp } from '../../auth/authz'
import { accountLinkOrigin } from '../../auth/security'
import { createSessionToken, hashSessionToken, hashPassword } from '../../auth/tokens'
import type { DbClient } from '../../db/client'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { queueTemplateMail } from '../../mail/delivery'
import { MailNotConfiguredError } from '../../mail/send'
import { createAuditEvent } from '../../repositories/audit'
import { activateInvitedUser, invitationIsCurrent, storeUserInvitation } from '../../repositories/userInvitations'
import type { AuthUser } from '../../repositories/users'
import type { RouteParams } from './routeTable'
import { mutationErrorResponse, requestAuditContext } from './shared'

export const UserInviteBodySchema = Type.Object({
  email: Type.String(),
  roleId: Type.String(),
  delivery: Type.Union([Type.Literal('email'), Type.Literal('link')]),
}, { additionalProperties: false })

export async function handleInviteUser(req: Request, db: DbClient, _params: RouteParams, actor: AuthUser): Promise<Response> {
  const stepUp = await requireStepUp(req, db, actor)
  if (stepUp) return stepUp
  const body = await readValidatedBody(req, UserInviteBodySchema)
  if (!body || !isValidEmail(body.email.trim())) return badRequest('Enter a valid email address')
  const roleError = await rejectsRoleAssignment(db, actor, body.roleId)
  if (roleError) return roleError
  const origin = accountLinkOrigin(req)
  if (!origin) return jsonResponse({ error: 'Set PUBLIC_ORIGIN on the server to create invitation links.' }, { status: 409 })

  const email = body.email.trim()
  const token = createSessionToken()
  const link = new URL('/admin/invitation', origin)
  link.hash = `invite=${token}`
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  const tokenHash = await hashSessionToken(token)
  // Login always verifies a valid password hash, including for suspended users.
  const passwordHash = await hashPassword(createSessionToken())
  const { roleId, delivery } = body
  async function issue(tx: DbClient) {
    const id = await storeUserInvitation(tx, { email, roleId, tokenHash, passwordHash, expiresAt })
    await createAuditEvent(tx, {
      actorUserId: actor.id, action: 'user.invite', targetType: 'user', targetId: id,
      metadata: { roleId, delivery }, ...requestAuditContext(req),
    })
  }
  try {
    if (delivery === 'link') {
      await db.transaction(issue)
      return jsonResponse({ link: link.href }, { status: 201, headers: { 'cache-control': 'no-store' } })
    }
    const outcome = await queueTemplateMail(db, {
      key: ADMIN_INVITE_TEMPLATE_KEY, to: email, variables: { link: link.href }, deliverBefore: expiresAt.getTime(),
    }, { onQueued: issue })
    if (outcome === 'disabled') return jsonResponse({ error: 'The admin invitation email is disabled. Create an invitation link instead.' }, { status: 409 })
    return jsonResponse({ queued: true }, { status: 201 })
  } catch (err) {
    if (err instanceof MailNotConfiguredError) {
      return jsonResponse({ error: 'Outgoing email is not set up. Create an invitation link instead.' }, { status: 409 })
    }
    return mutationErrorResponse(err)
  }
}

const AcceptInvitationSchema = Type.Object({
  token: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }),
  password: Type.String({ maxLength: 1024 }),
})

export async function handleAcceptInvitation(req: Request, db: DbClient): Promise<Response> {
  const body = await readValidatedBody(req, AcceptInvitationSchema)
  const invalid = () => jsonResponse({ error: 'This invitation has expired or is no longer valid. Ask for a new invitation.' }, { status: 400 })
  if (!body) return invalid()
  const password = body.password.trim()
  if (password.length < MIN_PASSWORD_LENGTH) return jsonResponse({ error: PASSWORD_TOO_SHORT_MESSAGE }, { status: 400 })
  const tokenHash = await hashSessionToken(body.token)
  if (!await invitationIsCurrent(db, tokenHash)) return invalid()
  const passwordHash = await hashPassword(password)
  return db.transaction(async (tx) => {
    const user = await activateInvitedUser(tx, tokenHash, passwordHash)
    if (!user) return invalid()
    await createAuditEvent(tx, {
      actorUserId: user.id, action: 'user.invite.accept', targetType: 'user', targetId: user.id,
      metadata: {}, ...requestAuditContext(req),
    })
    return jsonResponse({ email: user.email }, { headers: { 'cache-control': 'no-store' } })
  })
}
