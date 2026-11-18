/**
 * Host-side RPC timeout — `requestFromWorker` must never await a wedged
 * worker forever.
 *
 * A worker whose VM is spinning never *crashes*, so before the timeout
 * existed a hang was strictly worse than a crash: the pending promise (and
 * the HTTP install request / publish render awaiting it) hung forever and
 * crash recovery never engaged. On expiry the call now rejects with a
 * descriptive error AND the worker is routed through the same teardown as a
 * crash (`handleWorkerCrash`): terminate, reject sibling pendings, record a
 * crash event for the admin UI, respawn-or-park via the sliding window.
 *
 * Workers here are injected stubs — `workers` / `pendingRequests` are the
 * real shared host state, so the timeout path exercised is the production
 * one end to end (minus the actual Bun.Worker).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { requestFromWorker } from '../../../server/plugins/host/workerPool'
import { setCrashRecoveryHandler } from '../../../server/plugins/host/crashRecovery'
import { pendingRequests, workers } from '../../../server/plugins/host/workerState'
import type { MainToWorkerMessage } from '../../../server/plugins/protocol/messages'

function stubWorker(events: string[]): Worker {
  return {
    postMessage: () => { events.push('post') },
    terminate: () => { events.push('terminate') },
    addEventListener: () => { /* listeners unused for injected stubs */ },
  } as unknown as Worker
}

function lifecycleMsg(pluginId: string, correlationId: string): MainToWorkerMessage {
  return { kind: 'run-lifecycle', correlationId, pluginId, hook: 'activate' }
}

afterEach(() => {
  workers.clear()
  pendingRequests.clear()
})

describe('requestFromWorker timeout', () => {
  it('rejects with a descriptive error and resets the wedged worker', async () => {
    const events: string[] = []
    const crashes: Array<{ pluginId: string; reason: string }> = []
    setCrashRecoveryHandler(async ({ pluginId, reason }) => {
      crashes.push({ pluginId, reason })
    })
    workers.set('acme.wedged-a', stubWorker(events))

    await expect(
      requestFromWorker('acme.wedged-a', lifecycleMsg('acme.wedged-a', 'corr-timeout'), 'lifecycle-result', {
        timeoutMs: 40,
      }),
    ).rejects.toThrow('Plugin "acme.wedged-a" did not respond to run-lifecycle within 40ms')

    // Crash-style teardown engaged: worker terminated + dropped so the next
    // call respawns a fresh one, and no pending leaks behind.
    expect(events).toEqual(['post', 'terminate'])
    expect(workers.has('acme.wedged-a')).toBe(false)
    expect(pendingRequests.size).toBe(0)

    // The crash recovery handler (which persists the event the admin UI
    // surfaces) was invoked with the timeout reason. It runs via
    // queueMicrotask — yield once to let it land.
    await new Promise((res) => setTimeout(res, 0))
    expect(crashes).toEqual([
      {
        pluginId: 'acme.wedged-a',
        reason: 'Plugin "acme.wedged-a" did not respond to run-lifecycle within 40ms',
      },
    ])
  })

  it('rejects sibling pending calls for the same plugin when one call times out', async () => {
    setCrashRecoveryHandler(async () => { /* recorded elsewhere */ })
    workers.set('acme.wedged-b', stubWorker([]))

    // Capture rejections through synchronously-attached handlers — the
    // crash teardown rejects corr-2 in the same tick that times out corr-1,
    // so a late `.rejects` attachment would trip the unhandled-rejection
    // reporter.
    const asError = (e: unknown): Error | null => (e instanceof Error ? e : null)
    const first = requestFromWorker('acme.wedged-b', lifecycleMsg('acme.wedged-b', 'corr-1'), 'lifecycle-result', {
      timeoutMs: 40,
    }).then(() => null, asError)
    const second = requestFromWorker('acme.wedged-b', lifecycleMsg('acme.wedged-b', 'corr-2'), 'lifecycle-result', {
      timeoutMs: 60_000,
    }).then(() => null, asError)

    const firstErr = await first
    expect(firstErr?.message).toContain('did not respond to run-lifecycle within 40ms')
    // The wedged worker can't service corr-2 either — crash teardown
    // rejects it instead of leaving it pending for its full budget.
    const secondErr = await second
    expect(secondErr?.message).toMatch(/worker crashed/)
    expect(pendingRequests.size).toBe(0)
  })

  it('resolves normally and skips the reset when the reply arrives in time', async () => {
    const events: string[] = []
    workers.set('acme.healthy', stubWorker(events))

    const promise = requestFromWorker('acme.healthy', lifecycleMsg('acme.healthy', 'corr-ok'), 'lifecycle-result', {
      timeoutMs: 50,
    })
    // Deliver the worker's reply the same way handleWorkerMessage does:
    // remove the pending entry, then resolve it.
    const pending = pendingRequests.get('corr-ok')
    expect(pending).toBeDefined()
    pendingRequests.delete('corr-ok')
    pending!.resolve({ kind: 'lifecycle-result', correlationId: 'corr-ok', ok: true })

    const result = await promise
    expect(result.ok).toBe(true)

    // Wait past the deadline — the cleared timer must not reset the worker.
    await new Promise((res) => setTimeout(res, 80))
    expect(events).toEqual(['post'])
    expect(workers.has('acme.healthy')).toBe(true)
  })
})
