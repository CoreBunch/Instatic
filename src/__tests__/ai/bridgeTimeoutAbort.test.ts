import { describe, test, expect, afterEach } from 'bun:test'
import {
  createBridge,
  resolveBridgeToolResult,
  __destroyAllBridgesForTesting,
  __listActiveBridgesForTesting,
} from '../../../server/ai/runtime/transport'
import type { AiStreamEvent } from '../../../server/ai/runtime/types'

afterEach(() => __destroyAllBridgesForTesting())

/**
 * ISS-030: the browser tool bridge had no timeout and ignored the request
 * abort signal — a non-responding (or closed) browser left callBrowser pending
 * forever, hanging the SDK stream and leaking the bridge. A pending tool wait
 * must settle on abort and on timeout.
 */
describe('bridge tool-call settlement', () => {
  test('rejects calls made after destroy without creating an orphan waiter', async () => {
    let emitted = false
    const { bridgeId, bridge, destroy } = createBridge(() => {
      emitted = true
    })

    destroy()

    await expect(bridge.callBrowser('cms.write', { x: 1 })).rejects.toThrow(
      'AI chat stream ended before tool result arrived.',
    )
    expect(emitted).toBe(false)
    expect(__listActiveBridgesForTesting()).not.toContain(bridgeId)
  })

  test('rejects a pending tool call when the abort signal fires', async () => {
    const controller = new AbortController()
    const { bridge, destroy } = createBridge(() => {}, controller.signal)
    const pending = bridge.callBrowser('cms.write', { x: 1 })
    controller.abort()
    await expect(pending).rejects.toThrow(/abort/i)
    destroy()
  })

  test('rejects a pending tool call after the timeout elapses', async () => {
    const { bridge, destroy } = createBridge(() => {}, undefined, 20)
    const pending = bridge.callBrowser('cms.write', { x: 1 })
    await expect(pending).rejects.toThrow(/timed out/i)
    destroy()
  })

  test('a delivered tool result settles the call and clears the timeout', async () => {
    let requestId = ''
    const { bridgeId, bridge, destroy } = createBridge((ev: AiStreamEvent) => {
      if (ev.type === 'toolRequest') requestId = ev.requestId
    }, undefined, 1000)
    const pending = bridge.callBrowser('cms.write', { x: 1 })
    expect(requestId).not.toBe('')
    expect(resolveBridgeToolResult(bridgeId, requestId, { ok: true, data: { done: true } })).toBe(true)
    await expect(pending).resolves.toMatchObject({ ok: true })
    destroy()
    expect(__listActiveBridgesForTesting()).not.toContain(bridgeId)
  })
})

/**
 * Snapshot refresh: a mutating browser tool posts its post-mutation snapshot
 * back with the result. The bridge must hand that snapshot to onSnapshot BEFORE
 * resolving the waiter, so the driver loop's next server read tool sees fresh
 * state rather than the stale turn-start snapshot.
 */
describe('bridge snapshot refresh', () => {
  test('onSnapshot fires with the posted snapshot before the call resolves', async () => {
    let requestId = ''
    const seen: unknown[] = []
    const { bridgeId, bridge, destroy } = createBridge(
      (ev: AiStreamEvent) => {
        if (ev.type === 'toolRequest') requestId = ev.requestId
      },
      undefined,
      1000,
      (snapshot) => { seen.push(snapshot) },
    )
    const pending = bridge.callBrowser('site_add_page', { title: 'X' })
    const fresh = { pages: ['home', 'x'] }
    expect(
      resolveBridgeToolResult(bridgeId, requestId, { ok: true, data: { pageId: 'x' } }, fresh),
    ).toBe(true)
    await expect(pending).resolves.toMatchObject({ ok: true })
    // onSnapshot was invoked with exactly the posted snapshot.
    expect(seen).toEqual([fresh])
    destroy()
  })

  test('omitting the snapshot leaves onSnapshot uncalled (read-only tool)', async () => {
    let requestId = ''
    let calls = 0
    const { bridgeId, bridge, destroy } = createBridge(
      (ev: AiStreamEvent) => {
        if (ev.type === 'toolRequest') requestId = ev.requestId
      },
      undefined,
      1000,
      () => { calls += 1 },
    )
    const pending = bridge.callBrowser('site_render_snapshot', {})
    expect(resolveBridgeToolResult(bridgeId, requestId, { ok: true })).toBe(true)
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(calls).toBe(0)
    destroy()
  })
})

/**
 * The MCP editor runs relayed tools one at a time. Pushing a whole batch at
 * once started every call's timeout at push time, so calls queued behind slow
 * ones timed out before the editor even reached them. A serial bridge emits
 * the next request only after the previous one settles.
 */
describe('serial bridge delivery', () => {
  function serialBridge(timeoutMs = 1000, signal?: AbortSignal) {
    const requests: string[] = []
    const created = createBridge(
      (ev: AiStreamEvent) => {
        if (ev.type === 'toolRequest') requests.push(ev.requestId)
      },
      signal,
      timeoutMs,
      undefined,
      { serial: true },
    )
    return { ...created, requests }
  }

  test('emits the next request only after the previous one settles', async () => {
    const { bridgeId, bridge, destroy, requests } = serialBridge()
    const first = bridge.callBrowser('a', {})
    const second = bridge.callBrowser('b', {})
    expect(requests).toHaveLength(1)

    expect(resolveBridgeToolResult(bridgeId, requests[0], { ok: true, data: 1 })).toBe(true)
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(requests).toHaveLength(2)

    expect(resolveBridgeToolResult(bridgeId, requests[1], { ok: true, data: 2 })).toBe(true)
    await expect(second).resolves.toMatchObject({ ok: true })
    destroy()
  })

  test('a queued call’s timeout starts when it is emitted, not when it is queued', async () => {
    const { bridgeId, bridge, destroy, requests } = serialBridge(60)
    const first = bridge.callBrowser('slow', {})
    const second = bridge.callBrowser('fast', {})
    // The first call takes most of the timeout; the second must not expire
    // while it waits its turn.
    await new Promise((r) => setTimeout(r, 45))
    resolveBridgeToolResult(bridgeId, requests[0], { ok: true, data: 1 })
    await first
    await new Promise((r) => setTimeout(r, 30))
    expect(resolveBridgeToolResult(bridgeId, requests[1], { ok: true, data: 2 })).toBe(true)
    await expect(second).resolves.toMatchObject({ ok: true })
    destroy()
  })

  test('a timed-out call releases the slot to the next one', async () => {
    const { bridge, destroy, requests } = serialBridge(20)
    const first = bridge.callBrowser('stuck', {})
    const second = bridge.callBrowser('next', {})
    await expect(first).rejects.toThrow(/timed out/i)
    expect(requests).toHaveLength(2)
    await expect(second).rejects.toThrow(/timed out/i)
    destroy()
  })

  test('destroy rejects queued calls without emitting them', async () => {
    const { bridge, destroy, requests } = serialBridge()
    const first = bridge.callBrowser('a', {})
    const second = bridge.callBrowser('b', {})
    destroy()
    await expect(first).rejects.toThrow(/ended/)
    await expect(second).rejects.toThrow(/ended/)
    expect(requests).toHaveLength(1)
  })

  test('abort rejects queued calls without emitting them', async () => {
    const controller = new AbortController()
    const { bridge, destroy, requests } = serialBridge(1000, controller.signal)
    const first = bridge.callBrowser('a', {})
    const second = bridge.callBrowser('b', {})
    controller.abort()
    await expect(first).rejects.toThrow(/abort/i)
    await expect(second).rejects.toThrow(/abort/i)
    expect(requests).toHaveLength(1)
    destroy()
  })
})
