/**
 * Members admin API. Site members are the people with an account on the
 * published site; this is how an administrator manages them.
 *
 *   GET    /admin/api/cms/members                     — list, search, filter (+ counts, tags in use)
 *   POST   /admin/api/cms/members/invite              — invite an address
 *   GET    /admin/api/cms/members/settings            — sign-up mode, profile fields, link pages
 *   PUT    /admin/api/cms/members/settings            — change them (step-up)
 *   GET    /admin/api/cms/members/:id                 — one member: profile, tags, sessions, activity
 *   DELETE /admin/api/cms/members/:id                 — delete for good (step-up)
 *   POST   /admin/api/cms/members/:id/suspend         — block sign-in, end open sessions
 *   POST   /admin/api/cms/members/:id/unsuspend
 *   POST   /admin/api/cms/members/:id/sign-out        — end every session
 *   GET    /admin/api/cms/members/:id/export          — everything held about the member, plugins included
 *   POST   /admin/api/cms/members/:id/tags            — grant a tag
 *   DELETE /admin/api/cms/members/:id/tags            — withdraw one source's grant of a tag
 *   DELETE /admin/api/cms/members/:id/apps/:grantId   — sign the member out of one app
 *   GET    /admin/api/cms/members/apps                — apps that may sign a member in
 *   POST   /admin/api/cms/members/apps                — register one (step-up)
 *   DELETE /admin/api/cms/members/apps/:id            — remove one, signing everyone out of it (step-up)
 *
 * Reading needs `members.read` or `members.manage`; every change needs
 * `members.manage`. All SQL for the member tables lives in `server/members`
 * (gated by `members-admin-split.test.ts`); this file only decides who may
 * call it, and audits the call.
 */
import type { DbClient } from '../../db/client'
import {
  CreateMemberAppBodySchema,
  isGrantableMemberTag,
  MemberInviteInputSchema,
  MemberSettingsSchema,
  MemberTagInputSchema,
  MemberTagRemoveInputSchema,
  memberDataFilename,
  type MemberAdminStatus,
  type MemberDetail,
  type MemberSettings,
} from '@core/members'
import { MAIL_ADDRESS_PATTERN } from '@core/mail'
import { requireAnyCapability, requireCapability, requireStepUp } from '../../auth/authz'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import {
  ADMIN_TAG_SOURCE,
  deleteMemberAsAdmin,
  disconnectMemberAppAsAdmin,
  getMemberForAdmin,
  inviteMember,
  listMembersForAdmin,
  setMemberSuspended,
  signOutMemberEverywhere,
} from '../../members/admin'
import { memberLinkOrigin, memberMailAvailable } from '../../members/mail'
import { createMemberApp, deleteMemberApp, findMemberApp, listMemberApps } from '../../members/apps/store'
import { isAvailableMemberAppScope, listAvailableMemberAppScopes } from '../../members/apps/scopes'
import { memberSettingsView } from '../../members/settingsView'
import { listMemberPageOptions } from '../../members/pages'
import {
  findMemberById,
  getMemberSettings,
  grantMemberTag,
  recordMemberEvent,
  revokeMemberTag,
  saveMemberSettings,
} from '../../members/repository'
import { parseAllowedRedirectUri } from '../../oauth/protocol'
import { exportMemberDataWithPlugins } from '../../plugins/host/memberExport'
import { memberLimits } from '../../members/limits'
import { isCrossSiteFetch } from '../../auth/security'
import { createAuditEvent, type AuditAction } from '../../repositories/audit'
import type { AuthUser } from '../../repositories/users'
import { CMS_API_PREFIX, requestAuditContext } from './shared'
import { runRouteTable, type Route, type RouteParams } from './routeTable'

const MEMBERS_PREFIX = `${CMS_API_PREFIX}/members`
const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)
const STATUSES: readonly MemberAdminStatus[] = ['active', 'pending', 'suspended']
const NO_REQUEST = { ipAddress: null, userAgent: null }

function notFound(): Response {
  return jsonResponse({ error: 'Member not found' }, { status: 404 })
}

function reader(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireAnyCapability(req, db, ['members.read', 'members.manage'])
}

async function manager(req: Request, db: DbClient, stepUp = false): Promise<AuthUser | Response> {
  const user = await requireCapability(req, db, 'members.manage')
  if (user instanceof Response || !stepUp) return user
  return (await requireStepUp(req, db, user)) ?? user
}

async function audit(
  db: DbClient,
  req: Request,
  user: AuthUser,
  action: AuditAction,
  memberId: string | null,
  metadata: Record<string, string> = {},
): Promise<void> {
  await createAuditEvent(db, {
    actorUserId: user.id,
    action,
    targetType: 'member',
    ...(memberId ? { targetId: memberId } : {}),
    metadata,
    ...requestAuditContext(req),
  })
}

/** The member's address for the audit trail, which cannot look a member up by id. */
function emailOf(detail: MemberDetail | null): Record<string, string> {
  return detail ? { email: detail.member.email } : {}
}

// ─── List and detail ───────────────────────────────────────────────────────

async function handleList(req: Request, db: DbClient): Promise<Response> {
  const user = await reader(req, db)
  if (user instanceof Response) return user
  const query = new URL(req.url).searchParams
  const text = (name: string) => query.get(name)?.slice(0, 200) || undefined
  const tag = text('tag')
  return jsonResponse(
    await listMembersForAdmin(db, {
      search: text('q'),
      status: STATUSES.find((candidate) => candidate === query.get('status')),
      ...(tag && isGrantableMemberTag(tag) ? { tag } : {}),
      offset: Number.parseInt(query.get('offset') ?? '0', 10) || 0,
    }),
  )
}

async function handleDetail(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await reader(req, db)
  if (user instanceof Response) return user
  const detail = await getMemberForAdmin(db, params.id)
  return detail ? jsonResponse({ detail }) : notFound()
}

// ─── Invite ────────────────────────────────────────────────────────────────

async function handleInvite(req: Request, db: DbClient): Promise<Response> {
  const user = await manager(req, db)
  if (user instanceof Response) return user
  const input = await readValidatedBody(req, MemberInviteInputSchema)
  if (!input || !ADDRESS_RE.test(input.email.trim())) return badRequest('Enter a valid email address')
  const tags = input.tags ?? []
  if (!tags.every(isGrantableMemberTag)) return badRequest('A tag in the invitation cannot be given to a member')

  // An invitation is a link. Without the site's public address there is no
  // link at all; without outgoing email it can still be handed to the admin
  // to pass on, which is what `delivery: 'link'` asks for.
  const delivery = input.delivery ?? 'email'
  // The link sets the password of an account for that address, and here it
  // goes to the admin, not to the address. That is the admin vouching for
  // who they give it to, so it asks for step-up like the other actions that
  // cannot be taken back.
  if (delivery === 'link') {
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
  }
  const linkOrigin = memberLinkOrigin(req)
  if (!linkOrigin) {
    return jsonResponse(
      { error: 'The site does not know its public address, so it cannot make an invitation link. Set PUBLIC_ORIGIN on the server.' },
      { status: 409 },
    )
  }
  if (delivery === 'email' && !(await memberMailAvailable(db, req))) {
    return jsonResponse(
      { error: 'Outgoing email is not set up. Create an invitation link to pass on yourself, or set up a connector and a sender under Email.' },
      { status: 409 },
    )
  }

  const result = await inviteMember(db, { email: input.email, tags, linkOrigin, delivery })
  if (!result.ok) {
    const error = result.reason === 'no_page'
      ? 'The site has no page that accepts an invitation. Set the invitation page in Member settings first.'
      : 'That address already has an account.'
    return jsonResponse({ error }, { status: 409 })
  }
  await audit(db, req, user, 'member.invite', result.member.id, { email: result.member.email, delivery })
  return jsonResponse(
    { member: result.member, outcome: result.outcome, ...(result.link ? { link: result.link } : {}) },
    // The link signs someone in: it must not be kept by anything between the server and the admin.
    { status: result.outcome === 'invited' ? 201 : 200, headers: { 'cache-control': 'no-store' } },
  )
}

// ─── One member ────────────────────────────────────────────────────────────

async function handleSuspend(req: Request, db: DbClient, params: RouteParams, suspended: boolean): Promise<Response> {
  const user = await manager(req, db)
  if (user instanceof Response) return user
  if (!(await setMemberSuspended(db, params.id, suspended))) return notFound()
  const detail = await getMemberForAdmin(db, params.id)
  await audit(db, req, user, suspended ? 'member.suspend' : 'member.unsuspend', params.id, emailOf(detail))
  return jsonResponse({ detail })
}

async function handleSignOut(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await manager(req, db)
  if (user instanceof Response) return user
  if (!(await signOutMemberEverywhere(db, params.id))) return notFound()
  const detail = await getMemberForAdmin(db, params.id)
  await audit(db, req, user, 'member.signout', params.id, emailOf(detail))
  return jsonResponse({ detail })
}

/** Everything the site holds about one member, plugins' sections included, as a download. */
async function handleExport(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  // A link on another site must not start an export (it asks every plugin).
  if (isCrossSiteFetch(req)) return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  const user = await manager(req, db)
  if (user instanceof Response) return user
  const member = await findMemberById(db, params.id)
  if (!member) return notFound()
  const allowed = memberLimits.adminExportPerUser.consume(user.id)
  if (!allowed.ok) {
    return jsonResponse(
      { error: 'Too many member data downloads. Try again later.' },
      { status: 429, headers: { 'retry-after': String(Math.ceil(allowed.retryAfterMs / 1000)) } },
    )
  }
  const data = await exportMemberDataWithPlugins(db, member)
  await audit(db, req, user, 'member.export', member.id, { email: member.email })
  return jsonResponse(data, {
    headers: {
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${memberDataFilename(member.id)}"`,
    },
  })
}

async function handleDisconnectApp(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await manager(req, db)
  if (user instanceof Response) return user
  const appName = await disconnectMemberAppAsAdmin(db, params.id, params.grantId)
  if (appName === null) {
    return jsonResponse({ error: 'That app is not signed in to this account' }, { status: 404 })
  }
  const detail = await getMemberForAdmin(db, params.id)
  await audit(db, req, user, 'member.app.disconnect', params.id, { ...emailOf(detail), app: appName })
  return jsonResponse({ detail })
}

async function handleDelete(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await manager(req, db, true)
  if (user instanceof Response) return user
  const detail = await getMemberForAdmin(db, params.id)
  if (!detail || !(await deleteMemberAsAdmin(db, params.id))) return notFound()
  // The address is recorded here because the member row no longer carries it.
  await audit(db, req, user, 'member.delete', params.id, { email: detail.member.email })
  return jsonResponse({ ok: true })
}

async function handleGrantTag(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await manager(req, db)
  if (user instanceof Response) return user
  const input = await readValidatedBody(req, MemberTagInputSchema)
  if (!input || !isGrantableMemberTag(input.tag)) return badRequest('That tag cannot be given to a member')
  let expiresAt: string | null = null
  if (input.expiresAt) {
    const at = Date.parse(input.expiresAt)
    if (Number.isNaN(at) || at <= Date.now()) return badRequest('The end of a tag must be a date in the future')
    expiresAt = new Date(at).toISOString()
  }
  if (!(await getMemberForAdmin(db, params.id))) return notFound()
  await grantMemberTag(db, { memberId: params.id, tag: input.tag, source: ADMIN_TAG_SOURCE, expiresAt })
  await recordMemberEvent(db, params.id, 'tag_granted', NO_REQUEST, { tag: input.tag })
  const detail = await getMemberForAdmin(db, params.id)
  await audit(db, req, user, 'member.tag.grant', params.id, { ...emailOf(detail), tag: input.tag })
  return jsonResponse({ detail })
}

async function handleRevokeTag(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await manager(req, db)
  if (user instanceof Response) return user
  const input = await readValidatedBody(req, MemberTagRemoveInputSchema)
  if (!input) return badRequest('Name the tag and where it came from')
  if (!(await getMemberForAdmin(db, params.id))) return notFound()
  await revokeMemberTag(db, { memberId: params.id, tag: input.tag, source: input.source })
  await recordMemberEvent(db, params.id, 'tag_revoked', NO_REQUEST, { tag: input.tag })
  const detail = await getMemberForAdmin(db, params.id)
  await audit(db, req, user, 'member.tag.revoke', params.id, { ...emailOf(detail), tag: input.tag, source: input.source })
  return jsonResponse({ detail })
}

// ─── Settings ──────────────────────────────────────────────────────────────

async function handleGetSettings(req: Request, db: DbClient): Promise<Response> {
  const user = await reader(req, db)
  if (user instanceof Response) return user
  return jsonResponse(await memberSettingsView(req, db, await getMemberSettings(db)))
}

/** Field ids are binding keys and form field names: each must be one field. */
function settingsProblem(settings: MemberSettings): string | null {
  const ids = settings.profileFields.map((field) => field.id)
  if (new Set(ids).size !== ids.length) return 'Two profile fields share an id.'
  const reserved = ['email', 'password', 'token', 'request', 'decision', 'connection', 'currentPassword', 'newPassword']
  const clash = ids.find((id) => reserved.includes(id))
  return clash ? `"${clash}" is used by the member forms and cannot be a profile field id.` : null
}

async function handleSaveSettings(req: Request, db: DbClient): Promise<Response> {
  const user = await manager(req, db, true)
  if (user instanceof Response) return user
  const settings = await readValidatedBody(req, MemberSettingsSchema)
  if (!settings) return badRequest('Those member settings are not valid')
  const problem = settingsProblem(settings)
  if (problem) return badRequest(problem)
  const known = new Set((await listMemberPageOptions(db)).map((page) => page.id))
  if (Object.values(settings.pages).some((pageId) => pageId && !known.has(pageId))) {
    return badRequest('One of the chosen pages no longer exists. Pick a page from the list.')
  }
  await saveMemberSettings(db, settings)
  await audit(db, req, user, 'member.settings.update', null, { signupMode: settings.signupMode })
  return jsonResponse(await memberSettingsView(req, db, settings))
}

// ─── Sign-in for apps ──────────────────────────────────────────────────────

async function auditApp(
  db: DbClient,
  req: Request,
  user: AuthUser,
  action: 'member.app.create' | 'member.app.delete',
  app: { id: string; name: string },
): Promise<void> {
  await createAuditEvent(db, {
    actorUserId: user.id,
    action,
    targetType: 'member_app',
    targetId: app.id,
    metadata: { name: app.name },
    ...requestAuditContext(req),
  })
}

async function handleListApps(req: Request, db: DbClient): Promise<Response> {
  const user = await reader(req, db)
  if (user instanceof Response) return user
  return jsonResponse({ apps: await listMemberApps(db), availableScopes: listAvailableMemberAppScopes() })
}

async function handleCreateApp(req: Request, db: DbClient): Promise<Response> {
  const user = await manager(req, db, true)
  if (user instanceof Response) return user
  const input = await readValidatedBody(req, CreateMemberAppBodySchema)
  if (!input) return badRequest('An app needs a name, at least one redirect address and at least one thing it may ask for')
  const name = input.name.trim()
  if (!name) return badRequest('Give the app a name')
  const redirectUris = [...new Set(input.redirectUris.map((uri) => uri.trim()))]
  if (!redirectUris.every((uri) => parseAllowedRedirectUri(uri) !== null)) {
    return badRequest('Redirect addresses must use https, or http on this machine (127.0.0.1).')
  }
  if (new Set(input.scopes).size !== input.scopes.length) return badRequest('Name each thing the app may ask for once')
  if (!input.scopes.every(isAvailableMemberAppScope)) {
    return badRequest('The app may only ask for what this site offers: the built-in access and that of active plugins.')
  }
  const app = await createMemberApp(db, { name, redirectUris, scopes: input.scopes, createdByUserId: user.id })
  await auditApp(db, req, user, 'member.app.create', app)
  return jsonResponse(app, { status: 201 })
}

async function handleDeleteApp(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await manager(req, db, true)
  if (user instanceof Response) return user
  const app = await findMemberApp(db, params.id)
  if (!app || !(await deleteMemberApp(db, app.id))) return jsonResponse({ error: 'App not found' }, { status: 404 })
  await auditApp(db, req, user, 'member.app.delete', app)
  return jsonResponse({ ok: true })
}

// ─── Routes ────────────────────────────────────────────────────────────────

const MEMBER = new RegExp(`^${MEMBERS_PREFIX}/(?<id>[^/]+)$`)
const APP = new RegExp(`^${MEMBERS_PREFIX}/apps/(?<id>[^/]+)$`)
/** Three segments deep, so it never meets the two-segment registry route `apps/:id` (`APP`). */
const MEMBER_APP = new RegExp(`^${MEMBERS_PREFIX}/(?<id>[^/]+)/apps/(?<grantId>[^/]+)$`)
const action = (name: string) => new RegExp(`^${MEMBERS_PREFIX}/(?<id>[^/]+)/${name}$`)

// The fixed paths come first: `invite`, `settings` and `apps` would otherwise match `:id`.
export const MEMBER_ROUTES: Route<[]>[] = [
  { method: 'GET', pattern: MEMBERS_PREFIX, handler: handleList },
  { method: 'POST', pattern: `${MEMBERS_PREFIX}/invite`, handler: handleInvite },
  { method: 'GET', pattern: `${MEMBERS_PREFIX}/settings`, handler: handleGetSettings },
  { method: 'PUT', pattern: `${MEMBERS_PREFIX}/settings`, handler: handleSaveSettings },
  { method: 'GET', pattern: `${MEMBERS_PREFIX}/apps`, handler: handleListApps },
  { method: 'POST', pattern: `${MEMBERS_PREFIX}/apps`, handler: handleCreateApp },
  { method: 'DELETE', pattern: APP, handler: handleDeleteApp },
  { method: 'GET', pattern: MEMBER, handler: handleDetail },
  { method: 'DELETE', pattern: MEMBER, handler: handleDelete },
  { method: 'POST', pattern: action('suspend'), handler: (req, db, params) => handleSuspend(req, db, params, true) },
  { method: 'POST', pattern: action('unsuspend'), handler: (req, db, params) => handleSuspend(req, db, params, false) },
  { method: 'POST', pattern: action('sign-out'), handler: handleSignOut },
  { method: 'GET', pattern: action('export'), handler: handleExport },
  { method: 'POST', pattern: action('tags'), handler: handleGrantTag },
  { method: 'DELETE', pattern: action('tags'), handler: handleRevokeTag },
  { method: 'DELETE', pattern: MEMBER_APP, handler: handleDisconnectApp },
]

export function handleMembersRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, MEMBER_ROUTES)
}
