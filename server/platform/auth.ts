import { WorkOS, type Organization, type User } from '@workos-inc/node'
import type { DbClient } from '../db/client'
import { clientIp } from '../auth/security'
import type {
  OrganizationRole,
  PlatformAuthMode,
  PlatformUser,
} from '@core/platform/schemas'
import type { PlatformConfig } from './config'
import { consumeAuthAttempt, storeAuthAttempt } from './repository'

const PLATFORM_SESSION_COOKIE = 'instatic_platform_session'
const AUTH_ATTEMPT_TTL_MS = 10 * 60 * 1_000

export interface PlatformIdentity {
  authMode: PlatformAuthMode
  user: PlatformUser
  organizationId: string | null
  organizationRole: OrganizationRole
}

export interface PlatformAuthResult {
  identity: PlatformIdentity
  setCookie: string | null
}

export interface PlatformOrganizationProfile {
  id: string
  name: string
}

export interface PlatformOrganizationCreation {
  auth: PlatformAuthResult
  organization: PlatformOrganizationProfile
}

export class PlatformAuthenticator {
  readonly mode: PlatformAuthMode
  private readonly workos: WorkOS | null
  private readonly db: DbClient
  private readonly config: PlatformConfig

  constructor(
    db: DbClient,
    config: PlatformConfig,
  ) {
    this.db = db
    this.config = config
    if (config.authMode === 'disabled') {
      throw new Error('Cannot create a platform authenticator while disabled')
    }
    this.mode = config.authMode
    this.workos = config.workos
      ? new WorkOS(config.workos.apiKey, { clientId: config.workos.clientId })
      : null
  }

  async loginResponse(): Promise<Response> {
    if (this.mode === 'development') {
      return redirectResponse('/app')
    }
    const workos = this.requireWorkOs()
    const workosConfig = this.requireWorkOsConfig()
    const authorization = await workos.userManagement.getAuthorizationUrlWithPKCE({
      clientId: workosConfig.clientId,
      provider: 'authkit',
      redirectUri: workosConfig.redirectUri,
    })
    await storeAuthAttempt(this.db, {
      state: authorization.state,
      codeVerifier: authorization.codeVerifier,
      expiresAt: new Date(Date.now() + AUTH_ATTEMPT_TTL_MS).toISOString(),
    })
    return redirectResponse(authorization.url)
  }

  async callbackResponse(req: Request, url: URL): Promise<Response> {
    if (this.mode === 'development') return redirectResponse('/app')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) return authErrorResponse('Missing authorization response')

    const codeVerifier = await consumeAuthAttempt(this.db, state)
    if (!codeVerifier) return authErrorResponse('The sign-in attempt expired or was already used')

    const workos = this.requireWorkOs()
    const workosConfig = this.requireWorkOsConfig()
    const authentication = await workos.userManagement.authenticateWithCode({
      clientId: workosConfig.clientId,
      code,
      codeVerifier,
      ipAddress: clientIp(req) ?? undefined,
      userAgent: req.headers.get('user-agent') ?? undefined,
      session: {
        sealSession: true,
        cookiePassword: workosConfig.cookiePassword,
      },
    })
    if (!authentication.sealedSession) {
      throw new Error('WorkOS authentication did not return a sealed session')
    }
    return redirectResponse('/app', this.sessionCookie(authentication.sealedSession))
  }

  async authenticate(req: Request): Promise<PlatformAuthResult | null> {
    if (this.mode === 'development') {
      const dev = this.config.developmentIdentity
      return {
        identity: {
          authMode: 'development',
          user: {
            id: dev.userId,
            email: dev.email,
            name: dev.name,
            avatarUrl: null,
          },
          organizationId: dev.organizationId,
          organizationRole: 'owner',
        },
        setCookie: null,
      }
    }

    const sealedSession = readCookie(req, PLATFORM_SESSION_COOKIE)
    if (!sealedSession) return null
    const workos = this.requireWorkOs()
    const workosConfig = this.requireWorkOsConfig()
    const session = workos.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: workosConfig.cookiePassword,
    })
    const authentication = await session.authenticate()
    if (authentication.authenticated) {
      return {
        identity: identityFromWorkOs(authentication, this.mode),
        setCookie: null,
      }
    }

    const refreshed = await session.refresh()
    if (!refreshed.authenticated || !refreshed.sealedSession) return null
    return {
      identity: identityFromWorkOs(refreshed, this.mode),
      setCookie: this.sessionCookie(refreshed.sealedSession),
    }
  }

  async getOrganizationProfile(organizationId: string): Promise<PlatformOrganizationProfile> {
    if (this.mode === 'development') {
      return {
        id: this.config.developmentIdentity.organizationId,
        name: this.config.developmentIdentity.organizationName,
      }
    }
    const organization = await this.requireWorkOs().organizations.getOrganization(organizationId)
    return organizationProfile(organization)
  }

  async createOrganization(
    req: Request,
    identity: PlatformIdentity,
    name: string,
  ): Promise<PlatformOrganizationCreation> {
    if (this.mode === 'development') {
      const id = `org_local_${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`
      return {
        organization: { id, name },
        auth: {
          identity: { ...identity, organizationId: id, organizationRole: 'owner' },
          setCookie: null,
        },
      }
    }

    const workos = this.requireWorkOs()
    const organization = await workos.organizations.createOrganization({ name })
    await workos.userManagement.createOrganizationMembership({
      organizationId: organization.id,
      userId: identity.user.id,
    })

    const sealedSession = readCookie(req, PLATFORM_SESSION_COOKIE)
    if (!sealedSession) throw new Error('The WorkOS session cookie is missing')
    const session = workos.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: this.requireWorkOsConfig().cookiePassword,
    })
    const refreshed = await session.refresh({ organizationId: organization.id })
    if (!refreshed.authenticated || !refreshed.sealedSession) {
      throw new Error('WorkOS could not switch to the new organization')
    }
    return {
      organization: organizationProfile(organization),
      auth: {
        identity: {
          ...identityFromWorkOs(refreshed, this.mode),
          organizationRole: 'owner',
        },
        setCookie: this.sessionCookie(refreshed.sealedSession),
      },
    }
  }

  async logout(req: Request): Promise<{ redirectTo: string; setCookie: string }> {
    if (this.mode === 'development') {
      return { redirectTo: '/app', setCookie: this.clearSessionCookie() }
    }
    const sealedSession = readCookie(req, PLATFORM_SESSION_COOKIE)
    let redirectTo = '/app'
    if (sealedSession) {
      const session = this.requireWorkOs().userManagement.loadSealedSession({
        sessionData: sealedSession,
        cookiePassword: this.requireWorkOsConfig().cookiePassword,
      })
      redirectTo = await session.getLogoutUrl({ returnTo: `${this.config.appUrl}/app` })
    }
    return { redirectTo, setCookie: this.clearSessionCookie() }
  }

  private requireWorkOs(): WorkOS {
    if (!this.workos) throw new Error('WorkOS is not configured')
    return this.workos
  }

  private requireWorkOsConfig() {
    if (!this.config.workos) throw new Error('WorkOS is not configured')
    return this.config.workos
  }

  private sessionCookie(value: string): string {
    return serializeCookie(PLATFORM_SESSION_COOKIE, value, {
      secure: this.config.cookieSecure,
      maxAge: 60 * 60 * 24 * 30,
    })
  }

  private clearSessionCookie(): string {
    return serializeCookie(PLATFORM_SESSION_COOKIE, '', {
      secure: this.config.cookieSecure,
      maxAge: 0,
    })
  }
}

function identityFromWorkOs(
  authentication: {
    user: User
    organizationId?: string
    role?: string
    roles?: string[]
  },
  authMode: PlatformAuthMode,
): PlatformIdentity {
  return {
    authMode,
    user: {
      id: authentication.user.id,
      email: authentication.user.email,
      name: authentication.user.name,
      avatarUrl: authentication.user.profilePictureUrl,
    },
    organizationId: authentication.organizationId ?? null,
    organizationRole: mapOrganizationRole(authentication.roles?.[0] ?? authentication.role),
  }
}

function mapOrganizationRole(role: string | undefined): OrganizationRole {
  if (role === 'owner') return 'owner'
  if (role === 'admin') return 'admin'
  if (role === 'guest') return 'guest'
  return 'member'
}

function organizationProfile(organization: Organization): PlatformOrganizationProfile {
  return { id: organization.id, name: organization.name }
}

function readCookie(req: Request, name: string): string {
  const cookie = req.headers.get('cookie') ?? ''
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1))
  }
  return ''
}

function serializeCookie(
  name: string,
  value: string,
  options: { secure: boolean; maxAge: number },
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/app',
    `Max-Age=${options.maxAge}`,
  ]
  if (options.secure) attributes.push('Secure')
  return attributes.join('; ')
}

function redirectResponse(location: string, setCookie?: string): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' })
  if (setCookie) headers.append('set-cookie', setCookie)
  return new Response(null, { status: 302, headers })
}

function authErrorResponse(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}
