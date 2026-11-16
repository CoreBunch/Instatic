/**
 * Outgoing mail settings (all gated by `mail.manage`).
 *
 *   GET    /admin/api/cms/mail/settings — delivery mode + the saved account (never the password)
 *   PUT    /admin/api/cms/mail/settings — save the SMTP account (step-up)
 *   DELETE /admin/api/cms/mail/settings — remove the SMTP account (step-up)
 *   POST   /admin/api/cms/mail/test     — send a test message through the current delivery mode
 *   GET    /admin/api/cms/mail/outbox   — the delivery log, newest first
 *
 * Saving and removing ask for step-up: the account decides where every
 * sign-in and reset link is sent, so a hijacked session must not be able to
 * repoint it.
 */
import type { DbClient } from '../../db/client'
import { requireCapability, requireStepUp } from '../../auth/authz'
import { configuredPublicOrigin } from '../../auth/security'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { createAuditEvent } from '../../repositories/audit'
import { MailSettingsInputSchema, MailTestInputSchema, type MailSettingsView } from '@core/mail'
import { getErrorMessage } from '@core/utils/errorMessage'
import { listMailOutbox } from '../../mail/outbox'
import { mailDeliveryMode, MailNotConfiguredError, sendSiteMail } from '../../mail/send'
import {
  deleteMailSettings,
  getMailAccountView,
  MailPasswordUnreadableError,
  saveMailSettings,
} from '../../mail/settings'
import { MailDeliveryError, privateMailHostsAllowed } from '../../mail/transport'
import { CMS_API_PREFIX, requestAuditContext } from './shared'
import { runRouteTable, type Route } from './routeTable'

const MAIL_PREFIX = `${CMS_API_PREFIX}/mail`

async function readSettingsView(db: DbClient): Promise<MailSettingsView> {
  const account = await getMailAccountView(db)
  return {
    mode: mailDeliveryMode(account !== null),
    account,
    publicOrigin: configuredPublicOrigin(),
    privateHostsAllowed: privateMailHostsAllowed(),
  }
}

async function handleGetSettings(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'mail.manage')
  if (user instanceof Response) return user
  return jsonResponse({ settings: await readSettingsView(db) })
}

async function handleSaveSettings(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'mail.manage')
  if (user instanceof Response) return user
  const stepUp = await requireStepUp(req, db, user)
  if (stepUp) return stepUp

  const input = await readValidatedBody(req, MailSettingsInputSchema)
  if (!input) return badRequest('Invalid mail settings')
  await saveMailSettings(db, input, user.id)
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'mail.settings.update',
    targetType: 'mail',
    metadata: { host: input.host.toLowerCase(), port: input.port, fromAddress: input.fromAddress },
    ...requestAuditContext(req),
  })
  return jsonResponse({ settings: await readSettingsView(db) })
}

async function handleDeleteSettings(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'mail.manage')
  if (user instanceof Response) return user
  const stepUp = await requireStepUp(req, db, user)
  if (stepUp) return stepUp

  await deleteMailSettings(db)
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'mail.settings.delete',
    targetType: 'mail',
    ...requestAuditContext(req),
  })
  return jsonResponse({ settings: await readSettingsView(db) })
}

async function handleSendTest(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'mail.manage')
  if (user instanceof Response) return user
  const input = await readValidatedBody(req, MailTestInputSchema)
  if (!input) return badRequest('Enter a valid email address')

  try {
    const status = await sendSiteMail(db, {
      kind: 'test',
      to: input.to,
      subject: 'Instatic test email',
      text: 'This is a test message from your Instatic site. If you are reading it, outgoing email works.',
    })
    return jsonResponse({ status })
  } catch (err) {
    if (
      err instanceof MailDeliveryError ||
      err instanceof MailNotConfiguredError ||
      err instanceof MailPasswordUnreadableError
    ) {
      return jsonResponse({ error: err.message }, { status: 422 })
    }
    console.error('[mail]', getErrorMessage(err, 'Test email failed'))
    return jsonResponse({ error: 'The test email could not be sent.' }, { status: 500 })
  }
}

async function handleListOutbox(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'mail.manage')
  if (user instanceof Response) return user
  return jsonResponse({ entries: await listMailOutbox(db) })
}

const ROUTES: Route<[]>[] = [
  { method: 'GET', pattern: `${MAIL_PREFIX}/settings`, handler: handleGetSettings },
  { method: 'PUT', pattern: `${MAIL_PREFIX}/settings`, handler: handleSaveSettings },
  { method: 'DELETE', pattern: `${MAIL_PREFIX}/settings`, handler: handleDeleteSettings },
  { method: 'POST', pattern: `${MAIL_PREFIX}/test`, handler: handleSendTest },
  { method: 'GET', pattern: `${MAIL_PREFIX}/outbox`, handler: handleListOutbox },
]

export function handleMailRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, ROUTES)
}
