import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { configurePublicOrigins, resetPublicOrigins } from '../../../auth/security'
import type { DbClient } from '../../../db/client'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import { createSqliteClient } from '../../../db/sqlite'
import { pkceChallengeForVerifier } from '../connectors/token'
import {
  MCP_AUTHORIZATION_SERVER_METADATA_PATH,
  MCP_OAUTH_REGISTER_PATH,
  MCP_OAUTH_TOKEN_PATH,
  MCP_PATH_PROTECTED_RESOURCE_METADATA_PATH,
  MCP_PROTECTED_RESOURCE_METADATA_PATH,
} from '../paths'
import { tryHandleMcpOAuth } from './handler'
import { isRemoteMcpEndpoint } from './protocol'
import {
  createOAuthAuthorizationGrant,
  registerOAuthClient,
} from './store'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  return db
}

const PUBLIC_ORIGIN = 'https://cms.example.com'
const HOSTILE_HOST = 'attacker.example:18020'

function request(path: string, init?: RequestInit): Request {
  return new Request(`${PUBLIC_ORIGIN}${path}`, init)
}

/**
 * A request whose own URL and `Host` header name a host the operator never
 * configured. happy-dom (loaded by the test setup) strips the Fetch-spec
 * forbidden `Host` header from the constructor init, so it is set afterwards,
 * the same way a real Bun.serve request carries it.
 */
function hostileRequest(path: string, init?: RequestInit): Request {
  const req = new Request(`http://${HOSTILE_HOST}${path}`, init)
  req.headers.set('host', HOSTILE_HOST)
  return req
}

async function handle(req: Request, db: DbClient): Promise<Response> {
  const response = await tryHandleMcpOAuth(req, db, new URL(req.url).pathname)
  if (!response) throw new Error('OAuth handler returned null')
  return response
}

let db: DbClient
beforeEach(async () => {
  db = await freshDb()
  configurePublicOrigins([PUBLIC_ORIGIN])
})
afterEach(() => {
  resetPublicOrigins()
})

describe('MCP OAuth protocol endpoints', () => {
  it('only marks non-local HTTPS endpoints as ready for hosted clients', () => {
    expect(isRemoteMcpEndpoint('https://cms.example.com/_instatic/mcp')).toBe(true)
    expect(isRemoteMcpEndpoint('http://cms.example.com/_instatic/mcp')).toBe(false)
    expect(isRemoteMcpEndpoint('https://localhost:3000/_instatic/mcp')).toBe(false)
    expect(isRemoteMcpEndpoint('https://192.168.1.5/_instatic/mcp')).toBe(false)
    expect(isRemoteMcpEndpoint('https://instatic.internal/_instatic/mcp')).toBe(false)
  })

  it('advertises protected-resource and authorization-server metadata', async () => {
    const protectedResource = await handle(request(MCP_PROTECTED_RESOURCE_METADATA_PATH), db)
    expect(protectedResource.status).toBe(200)
    expect(protectedResource.headers.get('Cache-Control')).toContain('max-age=300')
    const resourceBody = await protectedResource.json() as Record<string, unknown>
    expect(resourceBody.resource).toBe('https://cms.example.com/_instatic/mcp')
    expect(resourceBody.authorization_servers).toEqual(['https://cms.example.com'])

    const authorizationServer = await handle(request(MCP_AUTHORIZATION_SERVER_METADATA_PATH), db)
    const serverBody = await authorizationServer.json() as Record<string, unknown>
    expect(serverBody.authorization_endpoint).toBe('https://cms.example.com/admin/ai/oauth/authorize')
    expect(serverBody.token_endpoint).toBe('https://cms.example.com/_instatic/oauth/token')
    expect(serverBody.registration_endpoint).toBe('https://cms.example.com/_instatic/oauth/register')
    expect(serverBody.code_challenge_methods_supported).toEqual(['S256'])
    expect(serverBody.token_endpoint_auth_methods_supported).toEqual(['none'])
  })

  it('dynamically registers a public Claude client', async () => {
    const response = await handle(request(MCP_OAUTH_REGISTER_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    }), db)
    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.json() as Record<string, unknown>
    expect(body.client_id).toMatch(/^imcp_client_/)
    expect(body.token_endpoint_auth_method).toBe('none')
    expect(body.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback'])
  })

  it('rejects non-HTTPS redirects outside a loopback host', async () => {
    const response = await handle(request(MCP_OAUTH_REGISTER_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Unsafe client',
        redirect_uris: ['http://attacker.example/callback'],
      }),
    }), db)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' })
  })

  it('exchanges a form-encoded authorization code without exposing cacheable credentials', async () => {
    const verifier = 'k'.repeat(64)
    const callback = 'https://claude.ai/api/mcp/auth_callback'
    const resource = 'https://cms.example.com/_instatic/mcp'
    const client = await registerOAuthClient(db, {
      clientName: 'Claude',
      redirectUris: [callback],
    })
    const { code } = await createOAuthAuthorizationGrant(db, {
      userId: 'u1',
      clientName: client.clientName,
      capabilities: ['site.read'],
      request: {
        responseType: 'code',
        clientId: client.clientId,
        redirectUri: callback,
        codeChallenge: await pkceChallengeForVerifier(verifier),
        codeChallengeMethod: 'S256',
        scope: 'mcp offline_access',
        resource,
      },
    })
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callback,
      client_id: client.clientId,
      code_verifier: verifier,
      resource,
    })
    const response = await handle(request(MCP_OAUTH_TOKEN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    }), db)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Pragma')).toBe('no-cache')
    expect(await response.json()).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp offline_access',
    })
  })

  it('rejects duplicate token parameters instead of resolving an ambiguous request', async () => {
    const response = await handle(request(MCP_OAUTH_TOKEN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&grant_type=authorization_code',
    }), db)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_request' })
  })
})

describe('MCP OAuth issuer trust', () => {
  const ISSUER_UNAVAILABLE = 'MCP OAuth needs PUBLIC_ORIGIN to be configured for this deployment.'

  it('answers 503 instead of advertising a Host-derived issuer when no public origin is configured', async () => {
    resetPublicOrigins()
    for (const path of [
      MCP_PROTECTED_RESOURCE_METADATA_PATH,
      MCP_PATH_PROTECTED_RESOURCE_METADATA_PATH,
      MCP_AUTHORIZATION_SERVER_METADATA_PATH,
    ]) {
      const response = await handle(hostileRequest(path), db)
      const text = await response.text()
      expect(response.status).toBe(503)
      expect(JSON.parse(text)).toEqual({ error: ISSUER_UNAVAILABLE })
      expect(text).not.toContain('attacker.example')
    }

    const token = await handle(hostileRequest(MCP_OAUTH_TOKEN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'imcp_rt_nope',
        client_id: 'imcp_client_nope',
        resource: `http://${HOSTILE_HOST}/_instatic/mcp`,
      }),
    }), db)
    const tokenText = await token.text()
    expect(token.status).toBe(503)
    expect(JSON.parse(tokenText)).toMatchObject({
      error: 'temporarily_unavailable',
      error_description: ISSUER_UNAVAILABLE,
    })
    expect(tokenText).not.toContain('attacker.example')
  })

  it('derives discovery from the loopback request origin in local development', async () => {
    resetPublicOrigins()
    const local = (path: string) => new Request(`http://localhost:3001${path}`)

    const protectedResource = await handle(local(MCP_PROTECTED_RESOURCE_METADATA_PATH), db)
    expect(protectedResource.status).toBe(200)
    expect(await protectedResource.json()).toMatchObject({
      resource: 'http://localhost:3001/_instatic/mcp',
      authorization_servers: ['http://localhost:3001'],
    })

    const authorizationServer = await handle(local(MCP_AUTHORIZATION_SERVER_METADATA_PATH), db)
    expect(authorizationServer.status).toBe(200)
    expect(await authorizationServer.json()).toMatchObject({
      issuer: 'http://localhost:3001',
      token_endpoint: 'http://localhost:3001/_instatic/oauth/token',
    })
  })

  it('pins every discovery value to the configured public origin, never the Host header', async () => {
    const protectedResource = await handle(hostileRequest(MCP_PROTECTED_RESOURCE_METADATA_PATH), db)
    expect(protectedResource.status).toBe(200)
    const resourceText = await protectedResource.text()
    expect(resourceText).not.toContain('attacker.example')
    expect(JSON.parse(resourceText)).toMatchObject({
      resource: `${PUBLIC_ORIGIN}/_instatic/mcp`,
      authorization_servers: [PUBLIC_ORIGIN],
    })

    const authorizationServer = await handle(hostileRequest(MCP_AUTHORIZATION_SERVER_METADATA_PATH), db)
    expect(authorizationServer.status).toBe(200)
    const serverText = await authorizationServer.text()
    expect(serverText).not.toContain('attacker.example')
    const serverBody = JSON.parse(serverText) as Record<string, unknown>
    for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
      expect(new URL(String(serverBody[key])).origin).toBe(PUBLIC_ORIGIN)
    }
  })
})
