import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

const BASE = '/admin/api/ai/editor-bridge'

describe('MCP editor bridge handler', () => {
  let harness: CapabilityTestHarness

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  it('requires a valid workspace scope from an authenticated user', async () => {
    const { cookie } = await harness.createRoleUser({
      name: 'Site Reader',
      slug: 'mcp-site-reader-query',
      capabilities: ['site.read'],
    })

    const missing = await harness.ai(BASE, { cookie })
    expect(missing.status).toBe(400)
    const invalid = await harness.ai(`${BASE}?scope=data`, { cookie })
    expect(invalid.status).toBe(400)
  })

  it('gates each bridge scope by access to its matching workspace', async () => {
    const siteUser = await harness.createRoleUser({
      name: 'Site Reader',
      slug: 'mcp-site-reader',
      capabilities: ['site.read'],
    })
    const contentUser = await harness.createRoleUser({
      name: 'Content Creator',
      slug: 'mcp-content-creator',
      capabilities: ['content.create'],
    })

    const siteDeniedContent = await harness.ai(`${BASE}?scope=content`, {
      cookie: siteUser.cookie,
    })
    expect(siteDeniedContent.status).toBe(403)
    const contentDeniedSite = await harness.ai(`${BASE}?scope=site`, {
      cookie: contentUser.cookie,
    })
    expect(contentDeniedSite.status).toBe(403)

    const siteCtrl = new AbortController()
    const siteAllowed = await harness.ai(`${BASE}?scope=site`, {
      cookie: siteUser.cookie,
      signal: siteCtrl.signal,
    })
    expect(siteAllowed.status).toBe(200)
    expect(siteAllowed.headers.get('content-type')).toBe('application/x-ndjson')
    siteCtrl.abort()

    const contentCtrl = new AbortController()
    const contentAllowed = await harness.ai(`${BASE}?scope=content`, {
      cookie: contentUser.cookie,
      signal: contentCtrl.signal,
    })
    expect(contentAllowed.status).toBe(200)
    expect(contentAllowed.headers.get('content-type')).toBe('application/x-ndjson')
    contentCtrl.abort()
  })
})
