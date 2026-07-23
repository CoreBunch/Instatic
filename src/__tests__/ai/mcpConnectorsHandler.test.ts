import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  expectStepUpRequired,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import type { CreateMcpAccessTokenResult, McpConnectionOverview } from '@core/ai'

const CONNECTIONS = '/admin/api/ai/mcp/connections'
const ACCESS_TOKENS = '/admin/api/ai/mcp/access-tokens'

describe('MCP connection management handler', () => {
  let harness: CapabilityTestHarness
  let originalError: typeof console.error

  beforeEach(async () => {
    originalError = console.error
    console.error = () => {}
    harness = await createCapabilityTestHarness()
  })

  afterEach(() => {
    console.error = originalError
  })

  it('creates a personal access token and returns its plaintext exactly once', async () => {
    const cookie = await harness.setupOwner()
    const res = await harness.ai(ACCESS_TOKENS, {
      method: 'POST',
      cookie,
      json: { label: 'Claude Code', capabilities: ['ai.chat', 'content.manage'] },
    })
    expect(res.status).toBe(201)
    const created = await readJson<CreateMcpAccessTokenResult>(res)
    expect(created.accessToken).toMatch(/^imcp_pat_/)
    expect(created.connection.id).toBeTruthy()
    expect(created.connection.authMode).toBe('bearer')
    expect(created.connection.revoked).toBe(false)

    const listRes = await harness.ai(CONNECTIONS, { cookie })
    expect(listRes.status).toBe(200)
    const overview = await readJson<McpConnectionOverview>(listRes)
    expect(overview.connections).toHaveLength(1)
    expect(overview.endpoint).toBe('http://localhost/_instatic/mcp')
    expect(overview.remoteAccess).toBe('local-only')
    expect(JSON.stringify(overview)).not.toContain(created.accessToken)
  })

  it('requires fresh step-up authentication before minting a personal access token', async () => {
    await harness.setupOwner()
    const { cookie } = await harness.createRoleUser({
      name: 'Connection Manager',
      slug: 'connection-manager',
      capabilities: ['ai.providers.manage', 'ai.chat'],
    })
    const res = await harness.ai(ACCESS_TOKENS, {
      method: 'POST',
      cookie,
      json: { label: 'Sensitive token', capabilities: ['ai.chat'] },
    })
    await expectStepUpRequired(res)
  })

  it('revokes a connection', async () => {
    const cookie = await harness.setupOwner()
    const created = await readJson<CreateMcpAccessTokenResult>(
      await harness.ai(ACCESS_TOKENS, {
        method: 'POST',
        cookie,
        json: { label: 'L', capabilities: ['ai.chat'] },
      }),
    )
    const del = await harness.ai(`${CONNECTIONS}/${created.connection.id}`, { method: 'DELETE', cookie })
    expect(del.status).toBe(200)

    const overview = await readJson<McpConnectionOverview>(await harness.ai(CONNECTIONS, { cookie }))
    expect(overview.connections[0].revoked).toBe(true)
  })

  it('404s revoking an unknown connection', async () => {
    const cookie = await harness.setupOwner()
    const del = await harness.ai(`${CONNECTIONS}/does-not-exist`, { method: 'DELETE', cookie })
    expect(del.status).toBe(404)
  })

  it('forbids connection management without ai.providers.manage', async () => {
    await harness.setupOwner()
    const { cookie } = await harness.createRoleUser({
      name: 'Editor', slug: 'editor', capabilities: ['ai.chat', 'content.manage'],
    })
    const res = await harness.ai(ACCESS_TOKENS, {
      method: 'POST',
      cookie,
      json: { label: 'x', capabilities: ['ai.chat'] },
    })
    expect(res.status).toBe(403)
  })

  it('refuses to grant capabilities the creator does not hold', async () => {
    await harness.setupOwner()
    const { cookie } = await harness.createRoleUser({
      name: 'AI Manager', slug: 'ai-manager', capabilities: ['ai.providers.manage', 'ai.chat'],
    })
    const res = await harness.ai(ACCESS_TOKENS, {
      method: 'POST',
      cookie,
      json: { label: 'overreach', capabilities: ['site.structure.edit'] },
    })
    expect(res.status).toBe(403)
  })

  it('rejects an invalid access-token body', async () => {
    const cookie = await harness.setupOwner()
    const res = await harness.ai(ACCESS_TOKENS, {
      method: 'POST',
      cookie,
      json: { label: '', capabilities: [] },
    })
    expect(res.status).toBe(400)
  })
})
