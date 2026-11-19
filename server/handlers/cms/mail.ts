/**
 * Email workspace API (all gated by `mail.manage`).
 *
 *   GET    /admin/api/cms/mail                          — delivery mode, connectors, defaults
 *   POST   /admin/api/cms/mail/connectors               — add a connector (step-up)
 *   DELETE /admin/api/cms/mail/connectors/:id           — remove a connector (step-up)
 *   PUT    /admin/api/cms/mail/connectors/:id/secret    — replace its secret (step-up)
 *   POST   /admin/api/cms/mail/connectors/:id/test      — send a test through it
 *   PUT    /admin/api/cms/mail/defaults                 — default connector and sender (step-up)
 *   GET    /admin/api/cms/mail/templates                — every template, with edits applied
 *   PUT    /admin/api/cms/mail/templates/:key           — save a template's wording (step-up)
 *   DELETE /admin/api/cms/mail/templates/:key           — back to the built-in wording (step-up)
 *   POST   /admin/api/cms/mail/templates/:key/test      — send it with sample values
 *   GET    /admin/api/cms/mail/activity?status=         — the delivery log
 *
 * Connectors and defaults decide where every sign-in and reset link is sent,
 * and templates decide what surrounds it, so changing any of them asks for
 * step-up: a hijacked session must not be able to repoint or reword the
 * site's mail.
 */
import type { DbClient } from '../../db/client'
import type { AuthUser } from '../../repositories/users'
import { requireCapability, requireStepUp } from '../../auth/authz'
import { configuredPublicOrigin } from '../../auth/security'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { createAuditEvent } from '../../repositories/audit'
import {
  MailConnectorInputSchema,
  MailConnectorSecretInputSchema,
  MailDefaultsSchema,
  MailTemplateInputSchema,
  MailTestInputSchema,
  TEST_MAIL_TEMPLATE_KEY,
  getMailTemplateDefinition,
  sampleMailVariables,
  type MailActivityPeriod,
  type MailActivityStatus,
  type MailOverview,
} from '@core/mail'
import { getErrorMessage } from '@core/utils/errorMessage'
import { CONNECTOR_TEST_KIND, listMailActivity } from '../../mail/activity'
import {
  createMailConnector,
  deleteMailConnector,
  getMailConnector,
  listMailConnectors,
  MailSecretUnreadableError,
  setMailConnectorSecret,
} from '../../mail/connectors'
import { wakeMailQueue } from '../../mail/delivery'
import { getMailDefaults, saveMailDefaults } from '../../mail/defaults'
import {
  buildTemplateMail,
  mailDeliveryMode,
  MailNotConfiguredError,
  sendConnectorTest,
  sendSiteMail,
} from '../../mail/send'
import { MailDeliveryError, privateMailHostsAllowed } from '../../mail/smtpDriver'
import {
  getMailTemplate,
  listMailTemplates,
  mailWordingProblem,
  resetMailTemplate,
  saveMailTemplate,
} from '../../mail/templates'
import { CMS_API_PREFIX, requestAuditContext } from './shared'
import { runRouteTable, type Route, type RouteParams } from './routeTable'

const MAIL_PREFIX = `${CMS_API_PREFIX}/mail`

function notFound(what: string): Response {
  return jsonResponse({ error: `${what} not found` }, { status: 404 })
}

async function readOverview(db: DbClient): Promise<MailOverview> {
  const defaults = await getMailDefaults(db)
  return {
    mode: mailDeliveryMode(defaults),
    connectors: await listMailConnectors(db),
    defaults,
    publicOrigin: configuredPublicOrigin(),
    privateHostsAllowed: privateMailHostsAllowed(),
  }
}

/** Gate on `mail.manage`, and on step-up for the changes that repoint mail. */
async function gate(req: Request, db: DbClient, stepUp: boolean): Promise<AuthUser | Response> {
  const user = await requireCapability(req, db, 'mail.manage')
  if (user instanceof Response || !stepUp) return user
  return (await requireStepUp(req, db, user)) ?? user
}

/** A delivery failure as a response: a safe sentence for the ones we understand. */
function deliveryFailure(err: unknown): Response {
  if (
    err instanceof MailDeliveryError ||
    err instanceof MailNotConfiguredError ||
    err instanceof MailSecretUnreadableError
  ) {
    return jsonResponse({ error: err.message }, { status: 422 })
  }
  console.error('[mail]', getErrorMessage(err, 'Test email failed'))
  return jsonResponse({ error: 'The test email could not be sent.' }, { status: 500 })
}

// ─── Overview, connectors, defaults ────────────────────────────────────────

async function handleOverview(req: Request, db: DbClient): Promise<Response> {
  const user = await gate(req, db, false)
  if (user instanceof Response) return user
  return jsonResponse({ overview: await readOverview(db) })
}

async function handleCreateConnector(req: Request, db: DbClient): Promise<Response> {
  const user = await gate(req, db, true)
  if (user instanceof Response) return user
  const input = await readValidatedBody(req, MailConnectorInputSchema)
  if (!input) return badRequest('Invalid connector')
  const connector = await createMailConnector(db, input, user.id)
  // The first connector becomes the one the site sends through, so adding
  // one is enough to get going; the owner can pick another under Defaults.
  const defaults = await getMailDefaults(db)
  if (defaults.defaultConnectorId === null) {
    await saveMailDefaults(db, { ...defaults, defaultConnectorId: connector.id }, user.id)
  }
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'mail.connector.create',
    targetType: 'mail_connector',
    targetId: connector.id,
    metadata: { label: connector.label, kind: connector.kind },
    ...requestAuditContext(req),
  })
  return jsonResponse({ connector }, { status: 201 })
}

async function handleDeleteConnector(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await gate(req, db, true)
  if (user instanceof Response) return user
  const connector = await getMailConnector(db, params.id)
  if (!connector || !(await deleteMailConnector(db, params.id))) return notFound('Connector')
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'mail.connector.delete',
    targetType: 'mail_connector',
    targetId: params.id,
    metadata: { label: connector.label, kind: connector.kind },
    ...requestAuditContext(req),
  })
  return jsonResponse({ overview: await readOverview(db) })
}

async function handleSetSecret(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await gate(req, db, true)
  if (user instanceof Response) return user
  const input = await readValidatedBody(req, MailConnectorSecretInputSchema)
  if (!input) return badRequest('Invalid secret')
  if (!(await setMailConnectorSecret(db, params.id, input.secret))) return notFound('Connector')
  // A new secret lifts a pause: what was held can go out now.
  wakeMailQueue()
  const connector = await getMailConnector(db, params.id)
  if (!connector) return notFound('Connector')
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'mail.connector.secret',
    targetType: 'mail_connector',
    targetId: params.id,
    metadata: { label: connector.label },
    ...requestAuditContext(req),
  })
  return jsonResponse({ connector })
}

async function handleTestConnector(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await gate(req, db, false)
  if (user instanceof Response) return user
  const input = await readValidatedBody(req, MailTestInputSchema)
  if (!input) return badRequest('Enter a valid email address')
  if (!(await getMailConnector(db, params.id))) return notFound('Connector')
  try {
    const mail = await buildTemplateMail(db, { key: TEST_MAIL_TEMPLATE_KEY, to: input.to, variables: {} })
    await sendConnectorTest(db, params.id, { ...mail, kind: CONNECTOR_TEST_KIND })
    // A test that worked lifts a pause: what was held can go out now.
    wakeMailQueue()
    return jsonResponse({ status: 'sent' })
  } catch (err) {
    return deliveryFailure(err)
  }
}

async function handleSaveDefaults(req: Request, db: DbClient): Promise<Response> {
  const user = await gate(req, db, true)
  if (user instanceof Response) return user
  const input = await readValidatedBody(req, MailDefaultsSchema)
  if (!input) return badRequest('Invalid mail defaults')
  if (input.defaultConnectorId !== null && !(await getMailConnector(db, input.defaultConnectorId))) {
    return badRequest('That connector no longer exists')
  }
  await saveMailDefaults(db, input, user.id)
  // Another connector, or a sender address at last: what was held can go out now.
  wakeMailQueue()
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'mail.defaults.update',
    targetType: 'mail',
    metadata: { fromAddress: input.fromAddress, connectorId: input.defaultConnectorId },
    ...requestAuditContext(req),
  })
  return jsonResponse({ overview: await readOverview(db) })
}

// ─── Templates ─────────────────────────────────────────────────────────────

async function handleListTemplates(req: Request, db: DbClient): Promise<Response> {
  const user = await gate(req, db, false)
  if (user instanceof Response) return user
  return jsonResponse({ templates: await listMailTemplates(db) })
}

async function handleSaveTemplate(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await gate(req, db, true)
  if (user instanceof Response) return user
  if (!getMailTemplateDefinition(params.key)) return notFound('Template')
  const input = await readValidatedBody(req, MailTemplateInputSchema)
  if (!input) return badRequest('A template needs a subject and a body')
  const definition = getMailTemplateDefinition(params.key)
  // A wording that would send an email with a variable still in it is not saved.
  const problem = definition ? mailWordingProblem(definition, input) : null
  if (problem) return badRequest(problem)
  await saveMailTemplate(db, params.key, input, user.id)
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'mail.template.update',
    targetType: 'mail_template',
    targetId: params.key,
    ...requestAuditContext(req),
  })
  return jsonResponse({ template: await getMailTemplate(db, params.key) })
}

async function handleResetTemplate(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await gate(req, db, true)
  if (user instanceof Response) return user
  if (!getMailTemplateDefinition(params.key)) return notFound('Template')
  await resetMailTemplate(db, params.key)
  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'mail.template.reset',
    targetType: 'mail_template',
    targetId: params.key,
    ...requestAuditContext(req),
  })
  return jsonResponse({ template: await getMailTemplate(db, params.key) })
}

async function handleTestTemplate(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await gate(req, db, false)
  if (user instanceof Response) return user
  const definition = getMailTemplateDefinition(params.key)
  if (!definition) return notFound('Template')
  const input = await readValidatedBody(req, MailTestInputSchema)
  if (!input) return badRequest('Enter a valid email address')
  try {
    // Sample values, never real ones: a test must not mint a working link.
    const mail = await buildTemplateMail(db, {
      key: params.key,
      to: input.to,
      variables: sampleMailVariables(definition.variables.filter((variable) => !variable.name.startsWith('site.'))),
    })
    return jsonResponse({ status: await sendSiteMail(db, mail) })
  } catch (err) {
    return deliveryFailure(err)
  }
}

// ─── Activity ──────────────────────────────────────────────────────────────

const STATUSES: readonly MailActivityStatus[] = ['sent', 'failed', 'captured']
const PERIODS: readonly MailActivityPeriod[] = ['24h', '7d', '30d', 'all']

async function handleActivity(req: Request, db: DbClient): Promise<Response> {
  const user = await gate(req, db, false)
  if (user instanceof Response) return user
  const query = new URL(req.url).searchParams
  const text = (name: string) => query.get(name)?.slice(0, 200) || undefined
  return jsonResponse(
    await listMailActivity(db, {
      period: PERIODS.find((candidate) => candidate === query.get('period')) ?? '30d',
      timeZone: text('tz'),
      status: STATUSES.find((candidate) => candidate === query.get('status')),
      kind: text('kind'),
      connector: text('connector'),
      search: text('q'),
      before: text('before'),
    }),
  )
}

const CONNECTOR = new RegExp(`^${MAIL_PREFIX}/connectors/(?<id>[^/]+)$`)
const CONNECTOR_SECRET = new RegExp(`^${MAIL_PREFIX}/connectors/(?<id>[^/]+)/secret$`)
const CONNECTOR_TEST = new RegExp(`^${MAIL_PREFIX}/connectors/(?<id>[^/]+)/test$`)
const TEMPLATE = new RegExp(`^${MAIL_PREFIX}/templates/(?<key>[^/]+)$`)
const TEMPLATE_TEST = new RegExp(`^${MAIL_PREFIX}/templates/(?<key>[^/]+)/test$`)

const ROUTES: Route<[]>[] = [
  { method: 'GET', pattern: MAIL_PREFIX, handler: handleOverview },
  { method: 'POST', pattern: `${MAIL_PREFIX}/connectors`, handler: handleCreateConnector },
  { method: 'DELETE', pattern: CONNECTOR, handler: handleDeleteConnector },
  { method: 'PUT', pattern: CONNECTOR_SECRET, handler: handleSetSecret },
  { method: 'POST', pattern: CONNECTOR_TEST, handler: handleTestConnector },
  { method: 'PUT', pattern: `${MAIL_PREFIX}/defaults`, handler: handleSaveDefaults },
  { method: 'GET', pattern: `${MAIL_PREFIX}/templates`, handler: handleListTemplates },
  { method: 'PUT', pattern: TEMPLATE, handler: handleSaveTemplate },
  { method: 'DELETE', pattern: TEMPLATE, handler: handleResetTemplate },
  { method: 'POST', pattern: TEMPLATE_TEST, handler: handleTestTemplate },
  { method: 'GET', pattern: `${MAIL_PREFIX}/activity`, handler: handleActivity },
]

export function handleMailRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, ROUTES)
}
