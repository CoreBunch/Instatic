import { describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness } from '../../../src/__tests__/helpers/capabilityHarness'
import type { DbClient } from '../../db/client'
import { handleMcpHttp } from './index'
import { pkceChallengeForVerifier } from './connectors/token'
import { tryHandleMcpOAuth } from './oauth/handler'
import { oauthTokenRateLimit } from './oauth/rateLimit'
import { createOAuthAuthorizationGrant, registerOAuthClient } from './oauth/store'
import { MCP_OAUTH_TOKEN_PATH } from './paths'

const RESOURCE = 'http://localhost/_instatic/mcp'
const REDIRECT_URI = 'http://localhost/callback'
const VERIFIER = 'p'.repeat(64)

async function callTool(db: DbClient, token: string) {
  const response = await handleMcpHttp(new Request(RESOURCE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'site_read_styles',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'site_read_styles', arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'account-access-test', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  }), db)
  if (!response) throw new Error('MCP route did not handle the request')
  return response
}

async function exchange(db: DbClient, params: Record<string, string>) {
  const response = await tryHandleMcpOAuth(new Request(`http://localhost${MCP_OAUTH_TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ resource: RESOURCE, ...params }).toString(),
  }), db, MCP_OAUTH_TOKEN_PATH)
  if (!response) throw new Error('OAuth route did not handle the request')
  return response
}

async function withCredentials(run: (fixture: Awaited<ReturnType<typeof credentials>>) => Promise<void>) {
  const fixture = await credentials()
  try {
    await run(fixture)
  } finally {
    await fixture.h.cleanup()
    oauthTokenRateLimit.reset('unknown')
  }
}

async function credentials() {
  const h = await createCapabilityTestHarness()
  try {
    const owner = await h.setupOwner()
    const user = await h.createRoleUser({
      name: 'Connector owner', slug: 'connector-owner',
      capabilities: ['ai.chat', 'ai.providers.manage', 'site.read'],
    })
    const cookie = await h.stepUp(user.cookie)
    const { rows } = await h.db<{ id: string }>`select id from users where email = ${user.email}`
    const userId = rows[0]!.id
    const created = await h.ai('/admin/api/ai/mcp/access-tokens', {
      method: 'POST', cookie, json: { label: 'Test', capabilities: ['site.read'], ttlDays: 1 },
    })
    expect(created.status).toBe(201)
    const personal: { accessToken: string } = await created.json()
    const client = await registerOAuthClient(h.db, { clientName: 'Test', redirectUris: [REDIRECT_URI] })
    const challenge = await pkceChallengeForVerifier(VERIFIER)
    const grant = () => createOAuthAuthorizationGrant(h.db, {
      userId, clientName: client.clientName, capabilities: ['ai.chat', 'site.read'],
      request: {
        responseType: 'code', clientId: client.clientId, redirectUri: REDIRECT_URI,
        codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'mcp offline_access', resource: RESOURCE,
      },
    })
    const codeParams = (code: string) => ({
      grant_type: 'authorization_code', code, client_id: client.clientId,
      redirect_uri: REDIRECT_URI, code_verifier: VERIFIER,
    })
    const issued = await exchange(h.db, codeParams((await grant()).code))
    expect(issued.status).toBe(200)
    const oauth: { access_token: string; refresh_token: string } = await issued.json()
    const refreshParams = { grant_type: 'refresh_token', client_id: client.clientId, refresh_token: oauth.refresh_token }
    const pendingCode = codeParams((await grant()).code)
    const tokens = { personal: personal.accessToken, oauth: oauth.access_token }
    for (const token of Object.values(tokens)) {
      const response = await callTool(h.db, token)
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.result?.isError).toBeFalsy()
      expect(body.result?.content).toBeDefined()
    }
    return { h, owner, user, userId, tokens, refreshParams, pendingCode }
  } catch (error) {
    await h.cleanup()
    throw error
  }
}

describe('MCP credentials follow the current account', () => {
  for (const state of ['suspended', 'deleted'] as const) {
    for (const credential of ['personal', 'oauth', 'refresh', 'code'] as const) {
      it(`rejects ${credential} credentials after the owner is ${state}`, async () => {
        await withCredentials(async ({ h, owner, user, userId, tokens, refreshParams, pendingCode }) => {
          if (state === 'suspended') {
            const suspended = await h.cms(`/admin/api/cms/users/${userId}`, {
              method: 'PATCH', cookie: owner, json: { status: 'suspended' },
            })
            expect(suspended.status).toBe(200)
          } else {
            // Soft deletion retains the connector rows, just as existing installations can.
            await h.db`update users set deleted_at = ${new Date()} where id = ${userId}`
          }
          const login = await h.cms('/admin/api/cms/login', {
            method: 'POST', json: { email: user.email, password: 'long-enough-password' },
          })
          expect(login.status).toBe(401)
          if (credential === 'personal' || credential === 'oauth') {
            const response = await callTool(h.db, tokens[credential])
            expect(response.status).toBe(401)
            expect(response.headers.get('WWW-Authenticate')).toContain('Bearer')
            expect(await response.json()).toEqual({ error: 'Unauthorized' })
          } else {
            const response = await exchange(h.db, credential === 'refresh' ? refreshParams : pendingCode)
            expect(response.status).toBe(400)
            expect((await response.json()).error).toBe('invalid_grant')
          }
        })
      })
    }
  }

  for (const credential of ['personal', 'oauth'] as const) {
    it(`limits ${credential} tools to the owner's current permissions`, async () => {
      await withCredentials(async ({ h, user, tokens }) => {
        await h.db`update roles set capabilities_json = ${JSON.stringify(['ai.chat'])} where id = ${user.roleId}`
        const denied = await callTool(h.db, tokens[credential])
        const body = await denied.json()
        expect(body.result?.isError).toBe(true)
        expect(body.result?.content).toEqual([{ type: 'text', text: 'Unknown tool: site_read_styles' }])
      })
    })

    it(`rejects ${credential} access when the owner loses AI access`, async () => {
      await withCredentials(async ({ h, owner, userId, tokens }) => {
        const changed = await h.cms(`/admin/api/cms/users/${userId}`, {
          method: 'PATCH', cookie: owner, json: { roleId: 'client' },
        })
        expect(changed.status).toBe(200)
        expect((await callTool(h.db, tokens[credential])).status).toBe(401)
      })
    })
  }

  it('keeps active-account refresh rotation working', async () => {
    await withCredentials(async ({ h, refreshParams }) => {
      const response = await exchange(h.db, refreshParams)
      expect(response.status).toBe(200)
      const rotated = await response.json()
      expect(rotated.refresh_token).not.toBe(refreshParams.refresh_token)
      const read = await callTool(h.db, rotated.access_token)
      expect(read.status).toBe(200)
      expect((await read.json()).result?.content).toBeDefined()
    })
  })

  it('allows valid credentials again after reactivation without undoing explicit revocation', async () => {
    await withCredentials(async ({ h, owner, userId, tokens, refreshParams, pendingCode }) => {
      const setStatus = (status: string) => h.cms(`/admin/api/cms/users/${userId}`, {
        method: 'PATCH', cookie: owner, json: { status },
      })
      expect((await setStatus('suspended')).status).toBe(200)
      expect((await exchange(h.db, refreshParams)).status).toBe(400)
      expect((await exchange(h.db, pendingCode)).status).toBe(400)
      expect((await setStatus('active')).status).toBe(200)
      for (const token of Object.values(tokens)) {
        expect((await callTool(h.db, token)).status).toBe(200)
      }
      expect((await exchange(h.db, refreshParams)).status).toBe(200)
      expect((await exchange(h.db, pendingCode)).status).toBe(200)
      await h.db`update ai_mcp_connectors set revoked_at = ${new Date()} where user_id = ${userId}`
      expect((await setStatus('suspended')).status).toBe(200)
      expect((await setStatus('active')).status).toBe(200)
      for (const token of Object.values(tokens)) {
        expect((await callTool(h.db, token)).status).toBe(401)
      }
    })
  })
})
