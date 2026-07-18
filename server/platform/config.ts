import type { PlatformAuthMode } from '@core/platform/schemas'

export type PlatformRuntimeAuthMode = PlatformAuthMode | 'disabled'

interface WorkOsPlatformConfig {
  apiKey: string
  clientId: string
  cookiePassword: string
  redirectUri: string
}

export interface PlatformConfig {
  enabled: boolean
  databaseUrl: string | null
  authMode: PlatformRuntimeAuthMode
  workos: WorkOsPlatformConfig | null
  cookieSecure: boolean
  appUrl: string
  developmentIdentity: {
    userId: string
    email: string
    name: string
    organizationId: string
    organizationName: string
  }
}

function isEnabledValue(value: string | undefined): boolean | null {
  if (value === undefined) return null
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error('CONTROL_PLANE_ENABLED must be true or false')
}

function configuredWorkOsMode(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.WORKOS_API_KEY &&
    env.WORKOS_CLIENT_ID &&
    env.WORKOS_COOKIE_PASSWORD,
  )
}

export function readPlatformConfig(
  env: Record<string, string | undefined>,
  publicOrigins: readonly string[],
): PlatformConfig {
  const production = env.NODE_ENV === 'production'
  const explicitEnabled = isEnabledValue(env.CONTROL_PLANE_ENABLED)
  const hasWorkOs = configuredWorkOsMode(env)
  const enabled = explicitEnabled ?? (!production || hasWorkOs)
  const authMode: PlatformRuntimeAuthMode = !enabled
    ? 'disabled'
    : (env.CONTROL_PLANE_AUTH_MODE as PlatformRuntimeAuthMode | undefined)
      ?? (hasWorkOs ? 'workos' : production ? 'disabled' : 'development')

  if (!['disabled', 'development', 'workos'].includes(authMode)) {
    throw new Error('CONTROL_PLANE_AUTH_MODE must be disabled, development, or workos')
  }
  if (enabled && authMode === 'disabled') {
    throw new Error('The enabled production control plane requires CONTROL_PLANE_AUTH_MODE=workos')
  }
  if (production && authMode === 'development') {
    throw new Error('CONTROL_PLANE_AUTH_MODE=development is not allowed in production')
  }

  const databaseUrl = env.CONTROL_PLANE_DATABASE_URL
    ?? (production ? null : 'sqlite:./.tmp/control-plane.db')
  if (enabled && !databaseUrl) {
    throw new Error('CONTROL_PLANE_DATABASE_URL is required when the control plane is enabled in production')
  }

  const appUrl = env.CONTROL_PLANE_APP_URL
    ?? publicOrigins[0]
    ?? 'http://localhost:5173'
  const redirectUri = env.WORKOS_REDIRECT_URI ?? `${appUrl}/app/auth/callback`
  const workos = authMode === 'workos'
    ? {
        apiKey: env.WORKOS_API_KEY ?? '',
        clientId: env.WORKOS_CLIENT_ID ?? '',
        cookiePassword: env.WORKOS_COOKIE_PASSWORD ?? '',
        redirectUri,
      }
    : null

  if (workos) {
    if (!workos.apiKey || !workos.clientId || !workos.cookiePassword) {
      throw new Error('WORKOS_API_KEY, WORKOS_CLIENT_ID, and WORKOS_COOKIE_PASSWORD are required')
    }
    if (workos.cookiePassword.length < 32) {
      throw new Error('WORKOS_COOKIE_PASSWORD must contain at least 32 characters')
    }
  }

  return {
    enabled,
    databaseUrl,
    authMode,
    workos,
    cookieSecure: new URL(redirectUri).protocol === 'https:',
    appUrl,
    developmentIdentity: {
      userId: env.CONTROL_PLANE_DEV_USER_ID ?? 'user_local_owner',
      email: env.CONTROL_PLANE_DEV_EMAIL ?? 'owner@local.instatic',
      name: env.CONTROL_PLANE_DEV_NAME ?? 'Local Owner',
      organizationId: env.CONTROL_PLANE_DEV_ORGANIZATION_ID ?? 'org_local_agency',
      organizationName: env.CONTROL_PLANE_DEV_ORGANIZATION_NAME ?? 'Local Agency',
    },
  }
}
