import {
  CreateOrganizationInputSchema,
  CreateProjectInputSchema,
  type OrganizationRole,
  type PlatformOrganization,
  type PlatformSession,
} from '@core/platform/schemas'
import { originAllowed } from '../auth/security'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../http'
import type { PlatformAuthResult, PlatformIdentity } from './auth'
import {
  countOrganizationMemberships,
  createProject,
  findOrganizationForUser,
  listProjectsForUser,
  uniqueOrganizationSlug,
  upsertOrganizationMembership,
  upsertPlatformOrganization,
  upsertPlatformUser,
} from './repository'
import type { PlatformRuntime } from './runtime'

const PLATFORM_API_PREFIX = '/app/api/'
const PLATFORM_AUTH_PREFIX = '/app/auth/'

export async function handlePlatformRequest(
  req: Request,
  runtime: PlatformRuntime | null,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url
  if (!pathname.startsWith(PLATFORM_API_PREFIX) && !pathname.startsWith(PLATFORM_AUTH_PREFIX)) {
    return null
  }
  if (!runtime) {
    return jsonResponse(
      { error: 'The Instatic control plane is not configured' },
      { status: 503 },
    )
  }

  if (pathname === '/app/auth/login') {
    if (req.method !== 'GET') return methodNotAllowed()
    return runtime.auth.loginResponse()
  }
  if (pathname === '/app/auth/callback') {
    if (req.method !== 'GET') return methodNotAllowed()
    return runtime.auth.callbackResponse(req, url)
  }

  if (!pathname.startsWith(PLATFORM_API_PREFIX)) {
    return jsonResponse({ error: 'Not found' }, { status: 404 })
  }
  if (req.method !== 'GET' && !originAllowed(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, { status: 403 })
  }

  const authenticated = await runtime.auth.authenticate(req)
  if (!authenticated) {
    return jsonResponse(
      { error: 'Unauthorized', loginUrl: '/app/auth/login' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    )
  }

  if (pathname === '/app/api/session') {
    if (req.method !== 'GET') return methodNotAllowed()
    const session = await synchronizeSession(runtime, authenticated)
    return withAuthCookie(
      jsonResponse({ session }, { headers: { 'cache-control': 'no-store' } }),
      authenticated,
    )
  }

  if (pathname === '/app/api/logout') {
    if (req.method !== 'POST') return methodNotAllowed()
    const logout = await runtime.auth.logout(req)
    const response = jsonResponse(
      { redirectTo: logout.redirectTo },
      { headers: { 'cache-control': 'no-store' } },
    )
    response.headers.append('set-cookie', logout.setCookie)
    return response
  }

  if (pathname === '/app/api/organizations') {
    if (req.method !== 'POST') return methodNotAllowed()
    if (authenticated.identity.organizationId) {
      return jsonResponse({ error: 'The session already has an active organization' }, { status: 409 })
    }
    const input = await readValidatedBody(req, CreateOrganizationInputSchema, { maxBytes: 8_192 })
    if (!input) return badRequest('Invalid organization')

    await upsertPlatformUser(runtime.db, authenticated.identity.user)
    const creation = await runtime.auth.createOrganization(req, authenticated.identity, input.name.trim())
    const slug = await uniqueOrganizationSlug(runtime.db, creation.organization.name, creation.organization.id)
    await upsertPlatformOrganization(runtime.db, {
      id: creation.organization.id,
      name: creation.organization.name,
      slug,
    })
    await upsertOrganizationMembership(runtime.db, {
      organizationId: creation.organization.id,
      userId: creation.auth.identity.user.id,
      role: 'owner',
    })
    const session = await synchronizeSession(runtime, creation.auth)
    return withAuthCookie(
      jsonResponse({ session }, { status: 201, headers: { 'cache-control': 'no-store' } }),
      creation.auth,
    )
  }

  if (pathname === '/app/api/projects') {
    const session = await synchronizeSession(runtime, authenticated)
    const organization = session.organization
    if (!organization) {
      return jsonResponse({ error: 'Create or select an organization first' }, { status: 409 })
    }

    if (req.method === 'GET') {
      const projects = await listProjectsForUser(runtime.db, organization, session.user.id)
      return withAuthCookie(jsonResponse({ projects }), authenticated)
    }
    if (req.method === 'POST') {
      if (organization.role === 'guest') {
        return jsonResponse({ error: 'Guests cannot create projects' }, { status: 403 })
      }
      const input = await readValidatedBody(req, CreateProjectInputSchema, { maxBytes: 16_384 })
      if (!input) return badRequest('Invalid project')
      const project = await createProject(runtime.db, {
        ...input,
        organizationId: organization.id,
        userId: session.user.id,
      })
      return withAuthCookie(jsonResponse({ project }, { status: 201 }), authenticated)
    }
    return methodNotAllowed()
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 })
}

async function synchronizeSession(
  runtime: PlatformRuntime,
  authenticated: PlatformAuthResult,
): Promise<PlatformSession> {
  const user = await upsertPlatformUser(runtime.db, authenticated.identity.user)
  const organization = await synchronizeOrganization(runtime, authenticated.identity)
  return {
    authMode: authenticated.identity.authMode,
    user,
    organization,
  }
}

async function synchronizeOrganization(
  runtime: PlatformRuntime,
  identity: PlatformIdentity,
): Promise<PlatformOrganization | null> {
  if (!identity.organizationId) return null
  const existing = await findOrganizationForUser(
    runtime.db,
    identity.organizationId,
    identity.user.id,
  )
  if (existing) return existing

  const profile = await runtime.auth.getOrganizationProfile(identity.organizationId)
  const slug = await uniqueOrganizationSlug(runtime.db, profile.name, profile.id)
  await upsertPlatformOrganization(runtime.db, {
    id: profile.id,
    name: profile.name,
    slug,
  })
  const membershipCount = await countOrganizationMemberships(runtime.db, profile.id)
  const role: OrganizationRole = membershipCount === 0
    ? 'owner'
    : identity.organizationRole
  await upsertOrganizationMembership(runtime.db, {
    organizationId: profile.id,
    userId: identity.user.id,
    role,
  })
  return findOrganizationForUser(runtime.db, profile.id, identity.user.id)
}

function withAuthCookie(response: Response, auth: PlatformAuthResult): Response {
  if (auth.setCookie) response.headers.append('set-cookie', auth.setCookie)
  return response
}
