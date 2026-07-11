import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { linkProxyFetchToDownstream } from './viteProxyLifecycle'

function downstreamResponse(writableFinished = false): {
  emitter: EventEmitter
  response: ServerResponse
} {
  const emitter = new EventEmitter()
  Object.defineProperty(emitter, 'writableFinished', {
    configurable: true,
    value: writableFinished,
  })
  return { emitter, response: emitter as unknown as ServerResponse }
}

describe('Vite backend proxy fetch lifecycle', () => {
  it('aborts an upstream fetch when the browser disconnects', () => {
    const downstream = downstreamResponse()
    const requestOptions: RequestInit = {}
    linkProxyFetchToDownstream(
      requestOptions,
      {} as IncomingMessage,
      downstream.response,
    )

    downstream.emitter.emit('close')

    expect(requestOptions.signal?.aborted).toBe(true)
  })

  it('does not abort after the downstream response finishes normally', () => {
    const downstream = downstreamResponse(true)
    const requestOptions: RequestInit = {}
    linkProxyFetchToDownstream(
      requestOptions,
      {} as IncomingMessage,
      downstream.response,
    )

    downstream.emitter.emit('close')

    expect(requestOptions.signal?.aborted).toBe(false)
  })

  it('preserves an existing upstream abort signal', () => {
    const downstream = downstreamResponse()
    const existingAbort = new AbortController()
    const requestOptions: RequestInit = { signal: existingAbort.signal }
    linkProxyFetchToDownstream(
      requestOptions,
      {} as IncomingMessage,
      downstream.response,
    )

    existingAbort.abort()

    expect(requestOptions.signal?.aborted).toBe(true)
  })
})
