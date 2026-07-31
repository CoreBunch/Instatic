import { beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../db/client'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import { createSqliteClient } from '../../../db/sqlite'
import { pkceChallengeForVerifier } from '../connectors/token'
import {
  MCP_AUTHORIZATION_SERVER_METADATA_PATH,
  MCP_OAUTH_REGISTER_PATH,
  MCP_OAUTH_TOKEN_PATH,
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

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://cms.example.com${path}`, init)
}

async function handle(req: Request, db: DbClient): Promise<Response> {
  const response = await tryHandleMcpOAuth(req, db, new URL(req.url).pathname)
  if (!response) throw new Error('OAuth handler returned null')
  return response
}

let db: DbClient
beforeEach(async () => { db = await freshDb() })

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
