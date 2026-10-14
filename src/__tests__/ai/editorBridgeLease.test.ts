/**
 * The MCP editor-bridge stream lease must be IDLE-based: relayed tool
 * traffic keeps the stream alive, and only a genuinely quiet stream is
 * recycled. A fixed lease used to close the stream at exactly two minutes,
 * failing whichever tool call straddled the boundary mid-batch (surfaced by
 * an external MCP agent driving long serialized class-assignment runs).
 */
import { describe, expect, it } from 'bun:test'
import {
  createEditorBridgeStream,
  getEditorBridgeForUser,
  hasEditorBridge,
} from '../../../server/ai/mcp/editorBridge'
import { resolveBridgeToolResult } from '../../../server/ai/runtime/transport'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Consume the stream in the background so enqueue never applies backpressure. */
function drain(stream: ReadableStream<Uint8Array>): void {
  void (async () => {
    const reader = stream.getReader()
    try {
      while (!(await reader.read()).done) {
        /* discard */
      }
    } catch {
      /* stream torn down by the test */
    }
  })()
}

/**
 * Play the editor: read the stream and answer each tool request `delayMs`
 * after it arrives, strictly one at a time — as `useMcpWorkspaceBridge` does.
 */
function playEditor(stream: ReadableStream<Uint8Array>, delayMs: number): void {
  void (async () => {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
    let bridgeId = ''
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += value
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line) continue
          const event = JSON.parse(line)
          if (event.type === 'bridgeReady') bridgeId = event.bridgeId
          if (event.type === 'toolRequest') {
            await sleep(delayMs)
            resolveBridgeToolResult(bridgeId, event.requestId, { ok: true, data: event.toolName })
          }
        }
      }
    } catch {
      /* stream torn down by the test */
    }
  })()
}

describe('editor bridge idle lease', () => {
  it('keeps an active stream alive past the lease while tools flow, then recycles it when idle', async () => {
    const controller = new AbortController()
    const userId = `lease-user-${Date.now()}`
    const stream = createEditorBridgeStream(userId, 'site', controller.signal, { idleLeaseMs: 80 })
    playEditor(stream, 5)
    await sleep(10)
    expect(hasEditorBridge(userId, 'site')).toBe(true)

    // Tool traffic every ~40ms for well past the 80ms lease: the stream must
    // survive because every relayed request re-arms the idle lease.
    for (let i = 0; i < 6; i++) {
      const bridge = getEditorBridgeForUser(userId, 'site')
      expect(bridge).not.toBeNull()
      await bridge?.callBrowser('noop_tool', {})
      await sleep(40)
      expect(hasEditorBridge(userId, 'site')).toBe(true)
    }

    // Quiet now: the idle lease must recycle the stream.
    await sleep(160)
    expect(hasEditorBridge(userId, 'site')).toBe(false)

    controller.abort()
  })

  it('recycles a stream that never sees tool traffic after one idle lease', async () => {
    const controller = new AbortController()
    const userId = `lease-idle-${Date.now()}`
    const stream = createEditorBridgeStream(userId, 'site', controller.signal, { idleLeaseMs: 60 })
    drain(stream)
    await sleep(10)
    expect(hasEditorBridge(userId, 'site')).toBe(true)

    await sleep(120)
    expect(hasEditorBridge(userId, 'site')).toBe(false)

    controller.abort()
  })
})

describe('editor bridge batch delivery', () => {
  it('survives a batch whose serial execution outlasts the idle lease', async () => {
    const controller = new AbortController()
    const userId = `lease-batch-${Date.now()}`
    const stream = createEditorBridgeStream(userId, 'site', controller.signal, { idleLeaseMs: 80 })

    playEditor(stream, 50)
    await sleep(10)

    // Four calls pushed together take ~200ms to execute serially — well past
    // the 80ms lease. Every one must still succeed.
    const bridge = getEditorBridgeForUser(userId, 'site')
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((name) => bridge!.callBrowser(name, {})),
    )
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true])
    expect(hasEditorBridge(userId, 'site')).toBe(true)

    controller.abort()
  })

  it('does not recycle the stream while a call is still pending', async () => {
    const controller = new AbortController()
    const userId = `lease-pending-${Date.now()}`
    const stream = createEditorBridgeStream(userId, 'site', controller.signal, { idleLeaseMs: 40 })
    drain(stream)
    await sleep(10)

    // Nothing answers: the call stays pending far past the lease. Closing the
    // stream now would reject it while the editor may still be working on it.
    const pending = getEditorBridgeForUser(userId, 'site')!.callBrowser('slow_tool', {})
    pending.catch(() => {})
    await sleep(150)
    expect(hasEditorBridge(userId, 'site')).toBe(true)

    controller.abort()
    await expect(pending).rejects.toThrow()
  })
})
