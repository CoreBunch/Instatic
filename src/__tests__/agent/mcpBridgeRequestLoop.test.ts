/**
 * #490 — one browser tool that never settles must not wedge the workspace
 * bridge. The request loop services relayed tools serially, so a hung
 * dispatcher used to block every later `toolRequest` on the stream until the
 * tab reloaded: each later call timed out server-side while `get_context`
 * kept reporting the workspace as connected. The loop now bounds each tool,
 * answers liveness probes itself, and keeps going.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { MCP_BRIDGE_PING_TOOL } from '@core/ai'
import type { AiToolOutput } from '@core/ai'
import {
  executeMcpBridgeRequest,
  runMcpWorkspaceBridgeConnection,
} from '@admin/ai/useMcpWorkspaceBridge'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

interface PostedResult {
  requestId: string
  result: AiToolOutput
}

/**
 * Serve one bridge stream carrying `events`, then answer every tool-result
 * POST with 200 and record it. Later connection attempts get 401 so the
 * caller's loop ends deterministically.
 */
function stubBridge(events: object[]): { posted: PostedResult[] } {
  const posted: PostedResult[] = []
  let streamsServed = 0
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('/admin/api/ai/tool-result')) {
      const body = JSON.parse(String(init?.body)) as PostedResult
      posted.push({ requestId: body.requestId, result: body.result })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    streamsServed += 1
    if (streamsServed > 1) return new Response(null, { status: 401 })
    return new Response(
      [...events.map((event) => JSON.stringify(event)), ''].join('\n'),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }) as typeof fetch
  return { posted }
}

const never = () => new Promise<AiToolOutput>(() => {})

describe('executeMcpBridgeRequest', () => {
  it('bounds a tool that never settles and names the tool in the error', async () => {
    const result = await executeMcpBridgeRequest(never, 'site_render_snapshot', {}, undefined, 20)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('site_render_snapshot')
    expect(result.error).toMatch(/did not finish/)
  })

  it('returns a tool result that arrives inside the deadline untouched', async () => {
    const result = await executeMcpBridgeRequest(
      async () => ({ ok: true, data: { nodeIds: ['n1'] } }),
      'site_insert_html',
      {},
      undefined,
      1_000,
    )
    expect(result).toEqual({ ok: true, data: { nodeIds: ['n1'] } })
  })

  it('counts the persistence step against the same deadline', async () => {
    const result = await executeMcpBridgeRequest(
      async () => ({ ok: true }),
      'content_set_document_fields',
      {},
      () => new Promise<void>(() => {}),
      20,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/did not finish/)
  })
})

describe('runMcpWorkspaceBridgeConnection', () => {
  it('keeps serving later requests after one tool hangs', async () => {
    const { posted } = stubBridge([
      { type: 'bridgeReady', bridgeId: 'b1' },
      { type: 'toolRequest', requestId: 'hangs', toolName: 'site_render_snapshot', input: {} },
      { type: 'toolRequest', requestId: 'after', toolName: 'site_get_node_html', input: { nodeId: 'n' } },
    ])
    const dispatched: string[] = []
    const dispatch = async (toolName: string): Promise<AiToolOutput> => {
      dispatched.push(toolName)
      if (toolName === 'site_render_snapshot') return never()
      return { ok: true, data: { html: '<p>hi</p>' } }
    }

    const lifecycle = new AbortController()
    const outcome = await Promise.race([
      runMcpWorkspaceBridgeConnection('site', dispatch, undefined, lifecycle.signal, { toolDeadlineMs: 30 }),
      new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 1_500)),
    ])
    lifecycle.abort()

    expect(outcome).toBe('transient')
    expect(dispatched).toEqual(['site_render_snapshot', 'site_get_node_html'])
    expect(posted.map((p) => p.requestId)).toEqual(['hangs', 'after'])
    expect(posted[0]?.result.ok).toBe(false)
    expect(posted[0]?.result.error).toMatch(/did not finish/)
    expect(posted[1]?.result).toEqual({ ok: true, data: { html: '<p>hi</p>' } })
  })

  it('answers a liveness probe itself without invoking the workspace dispatcher', async () => {
    const { posted } = stubBridge([
      { type: 'bridgeReady', bridgeId: 'b1' },
      { type: 'toolRequest', requestId: 'probe', toolName: MCP_BRIDGE_PING_TOOL, input: {} },
    ])
    let dispatches = 0
    const lifecycle = new AbortController()
    const outcome = await runMcpWorkspaceBridgeConnection(
      'site',
      async () => {
        dispatches += 1
        return { ok: true }
      },
      undefined,
      lifecycle.signal,
    )
    lifecycle.abort()

    expect(outcome).toBe('transient')
    expect(dispatches).toBe(0)
    expect(posted).toEqual([{ requestId: 'probe', result: { ok: true, data: { alive: true } } }])
  })
})
