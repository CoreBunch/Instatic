import { beforeEach, describe, expect, it } from 'bun:test'
import type {
  DecideMcpOAuthAuthorizationResult,
  McpConnectionOverview,
  McpOAuthAuthorizationRequest,
  McpOAuthAuthorizationView,
} from '@core/ai'
import { pkceChallengeForVerifier } from '../../../server/ai/mcp/connectors/token'
import { registerOAuthClient } from '../../../server/ai/mcp/oauth/store'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

const AUTHORIZATION = '/admin/api/ai/mcp/oauth/authorization'
const CONNECTIONS = '/admin/api/ai/mcp/connections'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const VERIFIER = 'v'.repeat(64)

function searchFor(request: McpOAuthAuthorizationRequest): string {
  const params = new URLSearchParams({
    response_type: request.responseType,
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
    scope: request.scope,
    resource: request.resource,
  })
  if (request.state) params.set('state', request.state)
  return params.toString()
}

describe('MCP OAuth authorization consent handler', () => {
  let harness: CapabilityTestHarness
  let request: McpOAuthAuthorizationRequest

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    const client = await registerOAuthClient(harness.db, {
      clientName: 'Claude Desktop',
      redirectUris: [CALLBACK],
    })
    request = {
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: CALLBACK,
      codeChallenge: await pkceChallengeForVerifier(VERIFIER),
      codeChallengeMethod: 'S256',
      scope: 'mcp offline_access',
      resource: 'http://localhost/_instatic/mcp',
      state: 'client-state',
    }
  })

  it('loads consent details and creates an OAuth connection after explicit approval', async () => {
    const cookie = await harness.setupOwner()
    const read = await harness.ai(`${AUTHORIZATION}?${searchFor(request)}`, { cookie })
    expect(read.status).toBe(200)
    const view = await readJson<McpOAuthAuthorizationView>(read)
    expect(view.clientName).toBe('Claude Desktop')
    expect(view.callbackUrl).toBe(CALLBACK)
    expect(view.grantExpiresInDays).toBe(90)

    const approve = await harness.ai(AUTHORIZATION, {
      method: 'POST',
      cookie,
      json: {
        decision: 'approve',
        request: view.request,
        capabilities: ['site.read'],
      },
    })
    expect(approve.status).toBe(200)
    const result = await readJson<DecideMcpOAuthAuthorizationResult>(approve)
    const redirect = new URL(result.redirectUrl)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CALLBACK)
    expect(redirect.searchParams.get('code')).toMatch(/^imcp_ac_/)
    expect(redirect.searchParams.get('state')).toBe('client-state')

    const overview = await readJson<McpConnectionOverview>(await harness.ai(CONNECTIONS, { cookie }))
    expect(overview.connections).toHaveLength(1)
    expect(overview.connections[0]).toMatchObject({
      label: 'Claude Desktop',
      authMode: 'oauth',
      capabilities: ['site.read', 'ai.chat'],
      revoked: false,
    })
    expect(JSON.stringify(overview)).not.toContain('imcp_ac_')
  })

  it('returns access_denied to the exact registered callback without creating a connection', async () => {
    const cookie = await harness.setupOwner()
    const denied = await harness.ai(AUTHORIZATION, {
      method: 'POST',
      cookie,
      json: { decision: 'deny', request },
    })
    expect(denied.status).toBe(200)
    const result = await readJson<DecideMcpOAuthAuthorizationResult>(denied)
    const redirect = new URL(result.redirectUrl)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CALLBACK)
    expect(redirect.searchParams.get('error')).toBe('access_denied')
    expect(redirect.searchParams.get('state')).toBe('client-state')

    const overview = await readJson<McpConnectionOverview>(await harness.ai(CONNECTIONS, { cookie }))
    expect(overview.connections).toHaveLength(0)
  })

  it('rejects a callback that was not registered for the client', async () => {
    const cookie = await harness.setupOwner()
    const tampered = { ...request, redirectUri: 'https://attacker.example/callback' }
    const response = await harness.ai(AUTHORIZATION, {
      method: 'POST',
      cookie,
      json: { decision: 'approve', request: tampered, capabilities: ['site.read'] },
    })
    expect(response.status).toBe(400)
  })

  it('rejects duplicate authorization parameters instead of choosing one', async () => {
    const cookie = await harness.setupOwner()
    const response = await harness.ai(
      `${AUTHORIZATION}?${searchFor(request)}&state=other-state`,
      { cookie },
    )
    expect(response.status).toBe(400)
  })

  it('refuses OAuth capabilities the approving user does not hold', async () => {
    await harness.setupOwner()
    const { cookie } = await harness.createRoleUser({
      name: 'AI Manager',
      slug: 'oauth-manager',
      capabilities: ['ai.providers.manage', 'ai.chat'],
    })
    const response = await harness.ai(AUTHORIZATION, {
      method: 'POST',
      cookie,
      json: { decision: 'approve', request, capabilities: ['site.structure.edit'] },
    })
    expect(response.status).toBe(403)
  })
})
