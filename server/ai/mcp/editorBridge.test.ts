import { describe, expect, it } from 'bun:test'
import { resolveBridgeToolResult } from '../runtime'
import { createEditorBridgeStream, getEditorBridgeBranch, getEditorBridgeForUser, hasEditorBridge, renewEditorBridge } from './editorBridge'

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
    expect(getEditorBridgeForUser(userId, 'site')).toBeNull()
    expect(hasEditorBridge(userId, 'site')).toBe(false)

    const ctrl = new AbortController()
    const stream = createEditorBridgeStream(userId, 'site', ctrl.signal)!
    const reader = stream.getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    expect(typeof ready.bridgeId).toBe('string')
    expect(getEditorBridgeForUser(userId, 'site')).not.toBeNull()

    ctrl.abort()
    // Give the abort listener a tick to run.
    await reader.read().catch(() => {})
    expect(getEditorBridgeForUser(userId, 'site')).toBeNull()
  })

  it('relays a tool call to the stream and resolves on the result POST', async () => {
    const userId = `u_${Math.floor(performance.now())}_2`
    const ctrl = new AbortController()
    const stream = createEditorBridgeStream(userId, 'site', ctrl.signal)!
    const reader = stream.getReader()
    const ready = await readUntil(reader, (e) => e.type === 'bridgeReady')
    const bridgeId = ready.bridgeId as string

    const bridge = getEditorBridgeForUser(userId, 'site')!
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

  it('keeps Site and Content bridges connected independently for one user', async () => {
    const userId = `u_${Math.floor(performance.now())}_scoped`
    const siteCtrl = new AbortController()
    const contentCtrl = new AbortController()
    const siteReader = createEditorBridgeStream(userId, 'site', siteCtrl.signal)!.getReader()
    const contentReader = createEditorBridgeStream(userId, 'content', contentCtrl.signal)!.getReader()

    await Promise.all([
      readUntil(siteReader, (e) => e.type === 'bridgeReady'),
      readUntil(contentReader, (e) => e.type === 'bridgeReady'),
    ])
    expect(hasEditorBridge(userId, 'site')).toBe(true)
    expect(hasEditorBridge(userId, 'content')).toBe(true)

    siteCtrl.abort()
    await siteReader.read().catch(() => {})
    expect(hasEditorBridge(userId, 'site')).toBe(false)
    expect(hasEditorBridge(userId, 'content')).toBe(true)

    contentCtrl.abort()
    await contentReader.read().catch(() => {})
    expect(hasEditorBridge(userId, 'content')).toBe(false)
  })

  it('clears a bridge when the stream consumer cancels without aborting the request', async () => {
    const userId = `u_${Math.floor(performance.now())}_cancelled`
    const ctrl = new AbortController()
    const reader = createEditorBridgeStream(userId, 'site', ctrl.signal)!.getReader()

    await readUntil(reader, (e) => e.type === 'bridgeReady')
    expect(hasEditorBridge(userId, 'site')).toBe(true)

    await reader.cancel()
    expect(ctrl.signal.aborted).toBe(false)
    expect(hasEditorBridge(userId, 'site')).toBe(false)
  })

  it('renews a quiet owner across successive leases and ignores replies for other bridges', async () => {
    const userId = 'quiet-site-owner'
    const open = () => createEditorBridgeStream(userId, 'site', new AbortController().signal, { idleLeaseMs: 200 })
    const reader = open()!.getReader()
    try {
      const ready = await readUntil(reader, event => event.type === 'bridgeReady')
      const bridgeId = String(ready.bridgeId)
      for (let i = 0; i < 3; i++) {
        await readUntil(reader, event => event.type === 'bridgePing')
        expect(renewEditorBridge('different-user', 'site', bridgeId)).toBe(false)
        expect(renewEditorBridge(userId, 'content', bridgeId)).toBe(false)
        expect(renewEditorBridge(userId, 'site', 'stale-bridge')).toBe(false)
        expect(renewEditorBridge(userId, 'site', bridgeId)).toBe(true)
        expect(open()).toBeNull()
      }
    } finally {
      await reader.cancel()
    }
  })

  it('keeps the first bridge and its branch until the owner closes', async () => {
    const userId = 'first-site-owner'
    const open = (branchId: string) => createEditorBridgeStream(
      userId, 'site', new AbortController().signal, { branchId },
    )
    const first = open('branch-a')!
    expect(open('branch-b')).toBeNull()
    expect(getEditorBridgeBranch(userId, 'site')).toBe('branch-a')
    await first.cancel()

    const next = open('branch-b')!
    expect(getEditorBridgeBranch(userId, 'site')).toBe('branch-b')
    await next.cancel()
  })
})
