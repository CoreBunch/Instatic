import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { login } from './helpers/auth'
import { ANONYMOUS_STATE, OWNER, PUBLIC_BASE_URL } from './helpers/constants'

/**
 * AI-011 — `get_context` reports what the workspace bridge can do right now.
 *
 * #490: a hosted deployment reported `siteConnected: true` while every
 * relayed browser tool failed. Registration only proved a tab had opened the
 * stream. The flag is now a real round-trip through the bridge, so a tab whose
 * main thread is wedged reads as `unresponsive`, and it recovers once the tab
 * answers again. Runs on a fresh login: minting a personal access token needs
 * a step-up, which rotates the session, so the shared owner state must not be
 * used here.
 */
test.use({ storageState: ANONYMOUS_STATE })

const MCP_URL = `${PUBLIC_BASE_URL}/_instatic/mcp`
let nextId = 1

async function mintAccessToken(page: Page): Promise<string> {
  // Same-origin browser fetches: the step-up opens the session's window, then
  // the token endpoint accepts the create. Both run inside the page so the
  // browser's own Origin and cookies apply, exactly as the admin UI does it.
  const token = await page.evaluate(async (password) => {
    const post = (path: string, body: unknown) => fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
    const stepUp = await post('/admin/api/cms/auth/step-up', { password })
    if (!stepUp.ok) throw new Error(`step-up failed: ${stepUp.status}`)
    const created = await post('/admin/api/ai/mcp/access-tokens', {
      label: 'AI-011 liveness',
      capabilities: ['ai.tools.write', 'site.read', 'site.structure.edit'],
    })
    if (!created.ok) throw new Error(`token create failed: ${created.status} ${await created.text()}`)
    const body = (await created.json()) as { accessToken: string }
    return body.accessToken
  }, OWNER.password)
  expect(token).toMatch(/^imcp_pat_/)
  return token
}

interface ToolCall {
  ms: number
  isError: boolean
  text: string
}

async function callTool(
  request: APIRequestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCall> {
  const params = {
    name,
    arguments: args,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'e2e-ai-011', version: '0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  }
  const started = Date.now()
  const res = await request.post(MCP_URL, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    data: { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params },
  })
  expect(res.status()).toBe(200)
  const json = (await res.json()) as {
    result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> }
  }
  return {
    ms: Date.now() - started,
    isError: json.result?.isError ?? false,
    text: json.result?.content?.map((c) => c.text ?? '').join('') ?? '',
  }
}

function editorState(call: ToolCall): { siteConnected: boolean; contentConnected: boolean; unresponsive: string[] } {
  return (JSON.parse(call.text) as { editor: { siteConnected: boolean; contentConnected: boolean; unresponsive: string[] } }).editor
}

test('get_context reflects whether the open Site editor actually answers (AI-011)', async ({ page, request }) => {
  test.setTimeout(90_000)
  await login(page)
  const token = await mintAccessToken(page)

  const bridgeOpened = page.waitForResponse((r) => new URL(r.url()).pathname === '/admin/api/ai/editor-bridge')
  await page.goto('/admin/site')
  expect((await bridgeOpened).status()).toBe(200)

  // A live editor answers the probe.
  await expect.poll(async () => editorState(await callTool(request, token, 'get_context', {})).siteConnected, {
    timeout: 15_000,
  }).toBe(true)
  expect(editorState(await callTool(request, token, 'get_context', {}))).toEqual({
    siteConnected: true,
    contentConnected: false,
    unresponsive: [],
  })

  // The reporter's step: an element the importer has no module for is
  // rejected, and the bridge keeps serving afterwards.
  const docs = await callTool(request, token, 'site_list_documents', {})
  const rootNodeId = /"rootNodeId":"([^"]+)"/.exec(docs.text)?.[1]
  expect(rootNodeId).toBeTruthy()
  const insert = await callTool(request, token, 'site_insert_html', {
    parentId: rootNodeId,
    index: 0,
    html: '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
  })
  expect(insert.isError).toBe(true)
  expect(insert.text).toContain('no importable elements')
  expect((await callTool(request, token, 'site_get_node_html', { nodeId: rootNodeId })).isError).toBe(false)

  // Wedge the tab: a busy main thread cannot read the stream, so the probe
  // must time out and the workspace must read as unresponsive — the state that
  // used to report `siteConnected: true`.
  await page.evaluate(() => {
    setTimeout(() => {
      const until = Date.now() + 7_000
      while (Date.now() < until) {
        /* hold the main thread */
      }
    }, 0)
  })
  const wedged = await callTool(request, token, 'get_context', {})
  expect(editorState(wedged)).toEqual({
    siteConnected: false,
    contentConnected: false,
    unresponsive: ['site'],
  })
  expect(wedged.ms).toBeGreaterThanOrEqual(2_000)

  // Once the tab answers again the bridge reconnects and the flag recovers.
  await expect.poll(async () => editorState(await callTool(request, token, 'get_context', {})), {
    timeout: 30_000,
  }).toEqual({ siteConnected: true, contentConnected: false, unresponsive: [] })
})
