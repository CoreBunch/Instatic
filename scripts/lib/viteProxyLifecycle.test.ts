import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpProxy } from 'vite'
import { configureProxyResponseLifecycle } from './viteProxyLifecycle'

function proxyHarness(): {
  upstream: EventEmitter
  downstream: EventEmitter
  destroyed: () => number
} {
  const proxy = new EventEmitter()
  const upstream = new EventEmitter()
  const downstream = new EventEmitter()
  let destroyCount = 0

  Object.assign(upstream, {
    destroy() {
      destroyCount += 1
      upstream.emit('close')
      return upstream
    },
  })

  configureProxyResponseLifecycle(proxy as unknown as HttpProxy.ProxyServer)
  proxy.emit(
    'proxyRes',
    upstream as unknown as IncomingMessage,
    {} as IncomingMessage,
    downstream as unknown as ServerResponse,
  )

  return { upstream, downstream, destroyed: () => destroyCount }
}

describe('Vite backend proxy response lifecycle', () => {
  it('destroys a streaming upstream response when the browser disconnects', () => {
    const harness = proxyHarness()
    harness.downstream.emit('close')
    expect(harness.destroyed()).toBe(1)
  })

  it('detaches cleanup after the upstream response ends normally', () => {
    const harness = proxyHarness()
    harness.upstream.emit('end')
    harness.downstream.emit('close')
    expect(harness.destroyed()).toBe(0)
  })
})
