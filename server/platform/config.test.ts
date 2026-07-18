import { describe, expect, it } from 'bun:test'
import { readPlatformConfig } from './config'

describe('readPlatformConfig', () => {
  it('provides a zero-configuration local control plane', () => {
    const config = readPlatformConfig({}, [])

    expect(config.enabled).toBe(true)
    expect(config.authMode).toBe('development')
    expect(config.databaseUrl).toBe('sqlite:./.tmp/control-plane.db')
    expect(config.developmentIdentity.organizationName).toBe('Local Agency')
  })

  it('stays disabled in production unless it is explicitly configured', () => {
    const config = readPlatformConfig({ NODE_ENV: 'production' }, [])

    expect(config.enabled).toBe(false)
    expect(config.authMode).toBe('disabled')
    expect(config.databaseUrl).toBeNull()
  })

  it('rejects production development authentication', () => {
    expect(() => readPlatformConfig({
      NODE_ENV: 'production',
      CONTROL_PLANE_ENABLED: 'true',
      CONTROL_PLANE_AUTH_MODE: 'development',
      CONTROL_PLANE_DATABASE_URL: 'postgres://example/control-plane',
    }, [])).toThrow('not allowed in production')
  })

  it('fails fast when an enabled production control plane has no auth provider', () => {
    expect(() => readPlatformConfig({
      NODE_ENV: 'production',
      CONTROL_PLANE_ENABLED: 'true',
      CONTROL_PLANE_DATABASE_URL: 'postgres://example/control-plane',
    }, [])).toThrow('requires CONTROL_PLANE_AUTH_MODE=workos')
  })

  it('builds a secure WorkOS configuration from production environment values', () => {
    const config = readPlatformConfig({
      NODE_ENV: 'production',
      CONTROL_PLANE_ENABLED: 'true',
      CONTROL_PLANE_AUTH_MODE: 'workos',
      CONTROL_PLANE_DATABASE_URL: 'postgres://example/control-plane',
      CONTROL_PLANE_APP_URL: 'https://app.instatic.example',
      WORKOS_API_KEY: 'sk_test_example',
      WORKOS_CLIENT_ID: 'client_example',
      WORKOS_COOKIE_PASSWORD: 'a'.repeat(32),
    }, [])

    expect(config.enabled).toBe(true)
    expect(config.authMode).toBe('workos')
    expect(config.cookieSecure).toBe(true)
    expect(config.workos?.redirectUri).toBe(
      'https://app.instatic.example/app/auth/callback',
    )
  })

  it('requires a strong WorkOS cookie password', () => {
    expect(() => readPlatformConfig({
      WORKOS_API_KEY: 'sk_test_example',
      WORKOS_CLIENT_ID: 'client_example',
      WORKOS_COOKIE_PASSWORD: 'too-short',
    }, [])).toThrow('at least 32 characters')
  })
})
