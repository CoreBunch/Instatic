/**
 * #490 — `get_context` reported `siteConnected: true` while every relayed
 * browser tool timed out. Registration only proves a tab opened a stream; a
 * stuck request loop or a connection that died behind a proxy keeps the entry
 * until the idle lease recycles it. `pingEditorBridge` must therefore be a
 * real round-trip, and a registered stream that does not answer must read as
 * unresponsive, not connected.
 */
import { describe, expect, it } from 'bun:test'
import { MCP_BRIDGE_PING_TOOL } from '@core/ai'
import { resolveBridgeToolResult } from '../../../server/ai/runtime'
import {
  createEditorBridgeStream,
  hasEditorBridge,
  pingEditorBridge,
} from '../../../server/ai/mcp/editorBridge'

const decoder = new TextDecoder()

interface StreamEvent {
  type: string
  bridgeId?: string
  requestId?: string
  toolName?: string
}

/**
 * Drain the stream like the workspace does, handing every parsed record to
 * `onEvent`. Returns a stop function that releases the reader.
 */
function consume(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: StreamEvent) => void,
): () => void {
  const reader = stream.getReader()
  let stopped = false
  void (async () => {
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || stopped) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed) onEvent(JSON.parse(trimmed))
        }
      }
    } catch {
      /* torn down by the test */
    }
  })()
  return () => {
    stopped = true
    reader.cancel().catch(() => {})
  }
}

describe('pingEditorBridge', () => {
  it('is closed when no workspace has registered a bridge', async () => {
    expect(await pingEditorBridge(`ping-none-${Date.now()}`, 'site', 50)).toBe('closed')
  })

  it('is live when the workspace loop answers the probe', async () => {
    const userId = `ping-live-${Date.now()}`
    const controller = new AbortController()
    const stream = createEditorBridgeStream(userId, 'site', controller.signal)
    let bridgeId = ''
    const stop = consume(stream, (event) => {
      if (event.type === 'bridgeReady') bridgeId = event.bridgeId ?? ''
      if (event.type === 'toolRequest' && event.toolName === MCP_BRIDGE_PING_TOOL) {
        resolveBridgeToolResult(bridgeId, event.requestId ?? '', { ok: true, data: { alive: true } })
      }
    })
    try {
      expect(await pingEditorBridge(userId, 'site', 1000)).toBe('live')
    } finally {
      stop()
      controller.abort()
    }
  })

  it('is unresponsive, not connected, when a registered stream never answers', async () => {
    const userId = `ping-stuck-${Date.now()}`
    const controller = new AbortController()
    // A consumer that reads the stream but never posts a result — the shape of
    // a tab whose request loop is blocked behind a tool that never settled.
    const stop = consume(createEditorBridgeStream(userId, 'site', controller.signal), () => {})
    try {
      expect(hasEditorBridge(userId, 'site')).toBe(true)
      expect(await pingEditorBridge(userId, 'site', 40)).toBe('unresponsive')
      // The registry still lists it: the probe reports, it does not evict.
      expect(hasEditorBridge(userId, 'site')).toBe(true)
    } finally {
      stop()
      controller.abort()
    }
  })

  it('is closed when the stream is torn down while the probe is in flight', async () => {
    const userId = `ping-torn-${Date.now()}`
    const controller = new AbortController()
    const stop = consume(createEditorBridgeStream(userId, 'site', controller.signal), () => {})
    try {
      const probe = pingEditorBridge(userId, 'site', 1000)
      controller.abort()
      expect(await probe).toBe('closed')
    } finally {
      stop()
    }
  })
})
