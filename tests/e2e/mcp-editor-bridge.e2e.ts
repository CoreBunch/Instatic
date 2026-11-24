import { expect, test } from '@playwright/test'
import { login } from './helpers/auth'
import { ANONYMOUS_STATE, OWNER } from './helpers/constants'

/**
 * AI-010 — the workspace MCP bridge stream stays readable in a real browser.
 *
 * The bridge body is newline-delimited JSON but the response is advertised as
 * `text/event-stream` so reverse proxies flush it incrementally. Unit coverage
 * stubs `fetch`, so only a browser can show that the real client still reads
 * the stream under that media type instead of an intermediary reframing it.
 */
test('opens the workspace bridge stream and keeps it readable (AI-010)', async ({ page }) => {
  const bridgeErrors: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('mcp-workspace-bridge') && msg.type() === 'error') bridgeErrors.push(text)
  })

  const bridgeResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/admin/api/ai/editor-bridge',
  )

  await page.goto('/admin/site')

  const response = await bridgeResponse
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toBe('text/event-stream')
  expect(response.headers()['cache-control']).toBe('no-cache, no-transform')
  expect(response.headers()['x-accel-buffering']).toBe('no')

  // The client must still be holding the stream open, not tearing it down as
  // unreadable. A reframed or buffered body surfaces as a parse/stream error.
  await page.waitForTimeout(3000)
  expect(bridgeErrors).toEqual([])
})

test.describe('MCP across tabs', () => {
  // Step-up rotates the owner's session. Use a fresh login for this spec.
  test.use({ storageState: ANONYMOUS_STATE })

  test('keeps an in-flight edit and the next call on the first tab until it closes (AI-011)', async ({
    page: owner, context, request, baseURL,
  }) => {
    test.setTimeout(90_000)
    await login(owner)
    const headers = { origin: new URL(baseURL!).origin }
    const stepUp = await owner.request.post('/admin/api/cms/auth/step-up', { headers, data: { password: OWNER.password } })
    expect(stepUp.ok()).toBe(true)
    const grant = await owner.request.post('/admin/api/ai/mcp/access-tokens', {
      headers, data: { label: 'AI-011', ttlDays: 1, capabilities: ['site.read', 'ai.tools.write', 'site.structure.edit'] },
    })
    expect(grant.status()).toBe(201)
    const { accessToken, connection } = await grant.json()
    let id = 0
    async function call(name: string, args: Record<string, unknown> = {}) {
      const version = '2026-07-28'
      const response = await request.post('/_instatic/mcp', {
        headers: {
          Authorization: `Bearer ${accessToken}`, Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': version, 'Mcp-Method': 'tools/call', 'Mcp-Name': name,
        },
        data: {
          jsonrpc: '2.0', id: ++id, method: 'tools/call',
          params: { name, arguments: args, _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientInfo': { name: 'handoff-test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          } },
        },
      })
      expect(response.ok()).toBe(true)
      const rpc = await response.json()
      expect(rpc.error).toBeUndefined()
      expect(rpc.result.isError, JSON.stringify(rpc.result.content)).toBeFalsy()
      return JSON.parse(rpc.result.content[0].text)
    }

    const title = `MCP tab ownership ${Date.now()}`
    const resultPath = '**/admin/api/ai/tool-result'
    const bridgePath = '**/admin/api/ai/editor-bridge?scope=site'
    const waiter = await context.newPage()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    try {
      const connected = owner.waitForResponse(bridgePath)
      await owner.goto('/admin/site')
      expect((await connected).status()).toBe(200)

      // Hold a real successful mutation's acknowledgement on the network.
      const reply = owner.waitForRequest(resultPath)
      await owner.route(resultPath, async route => {
        await held
        await route.continue()
      }, { times: 1 })
      async function switchTabsDuringEdit() {
        await reply
        const occupied = waiter.waitForResponse(bridgePath)
        await waiter.goto('/admin/site')
        expect((await occupied).status()).toBe(204)
        await owner.bringToFront()
        await waiter.bringToFront()
        release()
      }
      const [{ pageId }] = await Promise.all([
        call('site_add_page', { title }),
        switchTabsDuringEdit(),
      ])
      expect(typeof pageId).toBe('string')

      const nextReply = owner.waitForResponse(resultPath)
      await call('site_read_document')
      expect((await nextReply).status()).toBe(200)
      const catalog = await call('site_list_documents')
      expect(catalog.documents.filter((doc: { title: string }) => doc.title === title)).toHaveLength(1)

      const takeover = waiter.waitForResponse(r => r.url().includes('/editor-bridge?scope=site') && r.status() === 200)
      await owner.close()
      await takeover
      const successorReply = waiter.waitForResponse(resultPath)
      await call('site_delete_page', { pageId })
      expect((await successorReply).status()).toBe(200)
    } finally {
      release()
      await context.request.delete(`/admin/api/ai/mcp/connections/${connection.id}`, { headers })
    }
  })
})
