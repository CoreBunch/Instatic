import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../src/__tests__/helpers/capabilityHarness'
import { getDraftSite, saveDraftSite } from '../../repositories/site'
import { readArtefact, readStaticAsset } from '../../publish/staticArtefact'
import { createBearerConnection } from './connectors/store'
import { generatePersonalAccessToken, hashMcpSecret } from './connectors/token'
import { handleMcpHttp } from './transports/http'

interface AuditRow {
  action: string
  metadata_json: Record<string, unknown>
}

interface RpcResponse {
  result?: {
    isError?: boolean
    content?: unknown
  }
}

let rpcId = 0

function rpcRequest(token: string, method: string, params: unknown): Request {
  return new Request('http://localhost/_instatic/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
}

async function callMcp(
  harness: CapabilityTestHarness,
  uploadsDir: string,
  token: string,
  method: string,
  params: unknown,
): Promise<RpcResponse> {
  const response = await handleMcpHttp(
    rpcRequest(token, method, params),
    harness.db,
    { uploadsDir },
  )
  if (!response) throw new Error('MCP HTTP handler did not claim its endpoint')
  expect(response.status).toBe(200)
  const text = await response.text()
  const payload = text.startsWith('data:') ? text.slice(text.indexOf('{')) : text
  return JSON.parse(payload) as RpcResponse
}

describe('site_publish MCP tool', () => {
  let harness: CapabilityTestHarness
  let uploadsDir: string

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    uploadsDir = await mkdtemp(join(tmpdir(), 'mcp-publish-'))
  })

  afterEach(async () => {
    await harness.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('deploys the saved draft through the canonical static publish pipeline', async () => {
    const site = await getDraftSite(harness.db)
    if (!site) throw new Error('default site was not seeded')
    const now = Date.now()
    site.styleRules.issue195 = {
      id: 'issue195',
      name: 'p',
      kind: 'ambient',
      selector: 'p',
      order: 0,
      styles: { color: 'rgb(210 24 24)' },
      contextStyles: {},
      createdAt: now,
      updatedAt: now,
    }
    await saveDraftSite(harness.db, site)
    const { rows: users } = await harness.db<{ id: string }>`select id from users limit 1`
    const userId = users[0]?.id
    if (!userId) throw new Error('owner user was not seeded')

    const token = generatePersonalAccessToken()
    const connector = await createBearerConnection(harness.db, {
      userId,
      label: 'Publish regression',
      capabilities: ['ai.chat', 'ai.tools.write', 'pages.publish'],
      tokenHash: await hashMcpSecret(token),
    })
    await callMcp(harness, uploadsDir, token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'publish-test', version: '0' },
    })
    const result = await callMcp(
      harness,
      uploadsDir,
      token,
      'tools/call',
      { name: 'site_publish', arguments: {} },
    )
    expect(result.result?.isError).toBeFalsy()
    expect(JSON.stringify(result.result?.content)).toContain('publishedPages')

    const html = await readArtefact(uploadsDir, '/')
    expect(html).not.toBeNull()
    const cssPaths = [...(html ?? '').matchAll(/href="(\/_instatic\/css\/[^"]+\.css)"/g)]
      .map((match) => match[1]!)
    const cssAssets = await Promise.all(cssPaths.map((path) => readStaticAsset(uploadsDir, path)))
    const css = cssAssets
      .filter((asset): asset is Uint8Array => asset !== null)
      .map((asset) => new TextDecoder().decode(asset))
      .join('\n')
    expect(css).toContain('rgb(210 24 24)')

    const { rows } = await harness.db<AuditRow>`
      select action, metadata_json
      from audit_events
      where action = 'publish'
      order by created_at desc
      limit 1
    `
    expect(rows[0]?.metadata_json).toMatchObject({ source: 'mcp', connectorId: connector.id })
  })
})
