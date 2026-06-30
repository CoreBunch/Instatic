import { describe, expect, it } from 'bun:test'
import { resolveBridgeToolResult } from '../runtime'
import { createEditorBridgeStream, getEditorBridgeForUser, hasEditorBridge } from './editorBridge'

const dec = new TextDecoder()

/** Read NDJSON frames from the editor-bridge stream until `predicate` matches. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: { type: string; [k: string]: unknown }) => boolean,
): Promise<{ type: string; [k: string]: unknown }> {
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) throw new Error('stream ended before predicate matched')
    buffer += dec.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const event = JSON.parse(trimmed)
      if (predicate(event)) return event
    }
  }
}

describe('editor bridge', () => {
  it('registers a bridge for the user on connect and clears it on disconnect', async () => {
    const userId = `u_${Math.floor(performance.now())}`
    expect(getEditorBridgeForUser(userId)).toBeNull()
    expect(hasEditorBridge(userId)).toBe(false)

    const ctrl = new AbortController()
    const stream = createEditorBridgeStream(userId, ctrl.signal)
    const reader = stream.getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    expect(typeof ready.bridgeId).toBe('string')
    expect(getEditorBridgeForUser(userId)).not.toBeNull()

    ctrl.abort()
    // Give the abort listener a tick to run.
    await reader.read().catch(() => {})
    expect(getEditorBridgeForUser(userId)).toBeNull()
  })

  it('relays a tool call to the stream and resolves on the result POST', async () => {
    const userId = `u_${Math.floor(performance.now())}_2`
    const ctrl = new AbortController()
    const stream = createEditorBridgeStream(userId, ctrl.signal)
    const reader = stream.getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    const bridgeId = ready.bridgeId as string

    const bridge = getEditorBridgeForUser(userId)!
    const callPromise = bridge.callBrowser('site_insert_html', { html: '<p>hi</p>' })

    const toolRequest = await readUntil(reader, (e) => e.type === 'toolRequest')
    expect(toolRequest.toolName).toBe('site_insert_html')
    const requestId = toolRequest.requestId as string

    // Simulate the editor POSTing its result back.
    const matched = resolveBridgeToolResult(bridgeId, requestId, { ok: true, data: { inserted: 1 } })
    expect(matched).toBe(true)

    const result = await callPromise
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ inserted: 1 })

    ctrl.abort()
    await reader.read().catch(() => {})
  })
})
