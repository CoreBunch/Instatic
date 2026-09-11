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

describe('editor bridge idle lease', () => {
  it('keeps an active stream alive past the lease while tools flow, then recycles it when idle', async () => {
    const controller = new AbortController()
    const userId = `lease-user-${Date.now()}`
    const stream = createEditorBridgeStream(userId, 'site', controller.signal, 80)
    drain(stream)
    await sleep(10)
    expect(hasEditorBridge(userId, 'site')).toBe(true)

    // Tool traffic every ~40ms for well past the 80ms lease: the stream must
    // survive because every relayed request re-arms the idle lease.
    for (let i = 0; i < 6; i++) {
      const bridge = getEditorBridgeForUser(userId, 'site')
      expect(bridge).not.toBeNull()
      // Fire-and-forget: nothing posts a result in this test, and the call
      // rejects when the bridge is destroyed at the end.
      bridge?.callBrowser('noop_tool', {}).catch(() => {})
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
    const stream = createEditorBridgeStream(userId, 'site', controller.signal, 60)
    drain(stream)
    await sleep(10)
    expect(hasEditorBridge(userId, 'site')).toBe(true)

    await sleep(120)
    expect(hasEditorBridge(userId, 'site')).toBe(false)

    controller.abort()
  })
})
