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
