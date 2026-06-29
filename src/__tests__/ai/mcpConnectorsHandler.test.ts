import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import type { CreateMcpConnectorResult, McpConnectorList } from '@core/ai'

const BASE = '/admin/api/ai/mcp/connectors'

describe('MCP connector handler', () => {
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

  it('creates a connector and returns the token exactly once', async () => {
    const cookie = await harness.setupOwner()
    const res = await harness.ai(BASE, {
      method: 'POST',
      cookie,
      json: { label: 'Claude Code', type: 'local', capabilities: ['ai.chat', 'content.manage'] },
    })
    expect(res.status).toBe(201)
    const created = await readJson<CreateMcpConnectorResult>(res)
    expect(created.token).toMatch(/^imcp_/)
    expect(created.connector.id).toBeTruthy()
    expect(created.connector.revoked).toBe(false)

    // The token is never returned by the list endpoint.
    const listRes = await harness.ai(BASE, { cookie })
    expect(listRes.status).toBe(200)
    const list = await readJson<McpConnectorList>(listRes)
    expect(list.connectors).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(created.token)
  })

  it('revokes a connector', async () => {
    const cookie = await harness.setupOwner()
    const created = await readJson<CreateMcpConnectorResult>(
      await harness.ai(BASE, {
        method: 'POST',
        cookie,
        json: { label: 'L', type: 'remote', capabilities: ['ai.chat'] },
      }),
    )
    const del = await harness.ai(`${BASE}/${created.connector.id}`, { method: 'DELETE', cookie })
    expect(del.status).toBe(200)

    const list = await readJson<McpConnectorList>(await harness.ai(BASE, { cookie }))
    expect(list.connectors[0].revoked).toBe(true)
  })

  it('404s revoking an unknown connector', async () => {
    const cookie = await harness.setupOwner()
    const del = await harness.ai(`${BASE}/does-not-exist`, { method: 'DELETE', cookie })
    expect(del.status).toBe(404)
  })

  it('forbids connector management without ai.providers.manage', async () => {
    await harness.setupOwner()
    const { cookie } = await harness.createRoleUser({
      name: 'Editor', slug: 'editor', capabilities: ['ai.chat', 'content.manage'],
    })
    const res = await harness.ai(BASE, {
      method: 'POST',
      cookie,
      json: { label: 'x', type: 'local', capabilities: ['ai.chat'] },
    })
    expect(res.status).toBe(403)
  })

  it('refuses to grant capabilities the creator does not hold', async () => {
    await harness.setupOwner()
    // A manager who can configure AI but holds no site-edit capability.
    const { cookie } = await harness.createRoleUser({
      name: 'AI Manager', slug: 'ai-manager', capabilities: ['ai.providers.manage', 'ai.chat'],
    })
    const res = await harness.ai(BASE, {
      method: 'POST',
      cookie,
      json: { label: 'overreach', type: 'remote', capabilities: ['site.structure.edit'] },
    })
    expect(res.status).toBe(403)
  })

  it('rejects an invalid body', async () => {
    const cookie = await harness.setupOwner()
    const res = await harness.ai(BASE, {
      method: 'POST',
      cookie,
      json: { label: '', type: 'nope', capabilities: [] },
    })
    expect(res.status).toBe(400)
  })
})
