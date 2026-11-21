/**
 * A route handler that runs out of its wall-clock call budget answers 504.
 *
 * The worker reports the overrun on its `route-result` (`timedOut`); the host
 * turns that into a gateway timeout instead of a 500, and nothing else about
 * the worker changes: no teardown, no crash event. Any other handler failure
 * stays a 500.
 *
 * The worker here is an injected stub that answers each `run-route` with a
 * scripted result; `workers`, `pendingRequests` and `hostPlugins` are the
 * real shared host state.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { runRouteInWorker } from '../../../server/plugins/host/rpc'
import { hostPlugins } from '../../../server/plugins/host/registry'
import { pendingRequests, workers } from '../../../server/plugins/host/workerState'
import type { HostPluginRecord } from '../../../server/plugins/host/types'
import type { WorkerToMainMessage } from '../../../server/plugins/protocol/messages'

const PLUGIN_ID = 'acme.slow'

function answeringWorker(answer: (correlationId: string) => WorkerToMainMessage, events: string[]): Worker {
  return {
    postMessage: (msg: { correlationId: string }) => {
      events.push('post')
      queueMicrotask(() => {
        const pending = pendingRequests.get(msg.correlationId)
        pendingRequests.delete(msg.correlationId)
        pending?.resolve(answer(msg.correlationId))
      })
    },
    terminate: () => { events.push('terminate') },
    addEventListener: () => { /* listeners unused for injected stubs */ },
  } as unknown as Worker
}

function registerRoute(): void {
  hostPlugins.set(PLUGIN_ID, {
    manifest: { id: PLUGIN_ID },
    routes: new Map([['GET:/slow', { access: { kind: 'public' } }]]),
  } as unknown as HostPluginRecord)
}

async function callRoute(): Promise<Response> {
  return runRouteInWorker({
    pluginId: PLUGIN_ID,
    method: 'GET',
    path: '/slow',
    request: new Request('https://site.example/_instatic/plugins/acme.slow/slow'),
    user: null,
    member: null,
  })
}

afterEach(() => {
  workers.clear()
  pendingRequests.clear()
  hostPlugins.delete(PLUGIN_ID)
})

describe('plugin route: time budget', () => {
  it('answers 504 when the handler ran out of its call budget, and keeps the worker', async () => {
    const events: string[] = []
    registerRoute()
    workers.set(
      PLUGIN_ID,
      answeringWorker(
        (correlationId) => ({
          kind: 'route-result',
          correlationId,
          ok: false,
          error: 'Plugin call exceeded its 20s time budget',
          timedOut: true,
        }),
        events,
      ),
    )

    const res = await callRoute()

    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ error: 'Plugin call exceeded its 20s time budget' })
    expect(events).toEqual(['post'])
    expect(workers.has(PLUGIN_ID)).toBe(true)
  })

  it('answers 500 for any other handler failure', async () => {
    registerRoute()
    workers.set(
      PLUGIN_ID,
      answeringWorker(
        (correlationId) => ({ kind: 'route-result', correlationId, ok: false, error: 'boom' }),
        [],
      ),
    )

    const res = await callRoute()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'boom' })
  })
})
