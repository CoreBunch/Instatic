/**
 * Dispatch cool-off: a dispatch whose handler keeps overrunning its call
 * budget is held back for a short, growing while and resumes by itself. An
 * overrun never parks the plugin (a visitor who can cause a dispatch must not
 * be able to switch a plugin off). While a dispatch is held back the host
 * does not send it, uses that kind's fallback, and marks the render it
 * belonged to so it is never cached.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  clearDispatchCoolOffs,
  recordDispatchOverrun,
  dispatchCoolOffRemainingMs,
} from '../../../server/plugins/host/dispatchCoolOff'
import { clearPluginCrashCounter, recordCrashAndDecide } from '../../../server/plugins/host/crashRecovery'
import { runMediaUrlTransformerInWorker } from '../../../server/plugins/host/media'
import { watchPluginOutput } from '../../../server/plugins/host/outputWatch'
import { hostPlugins } from '../../../server/plugins/host/registry'
import { runHookFilterInWorker, runHookListenerInWorker, runLoopFetchInWorker, runRouteInWorker } from '../../../server/plugins/host/rpc'
import { workers } from '../../../server/plugins/host/workerState'
import type { HostPluginRecord } from '../../../server/plugins/host/types'
import { getOrRender, resetForTests } from '../../../server/publish/renderCache'

const PLUGIN = 'acme.cooloff'
const T0 = 1_000_000_000_000

afterEach(() => {
  clearDispatchCoolOffs(PLUGIN)
  clearPluginCrashCounter(PLUGIN)
})

describe('route cool-off', () => {
  it('lets the first overrun pass, then grows 15 s, 30 s, 60 s, 2 min, capped at 5 min', () => {
    const steps = [0, 1, 2, 3, 4, 5, 6].map((n) => recordDispatchOverrun(PLUGIN, 'route GET:/slow', T0 + n * 1000))
    expect(steps).toEqual([0, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000])
  })

  it('holds the route back until the cool-off ends, then lets it through again', () => {
    recordDispatchOverrun(PLUGIN, 'route GET:/slow', T0)
    expect(dispatchCoolOffRemainingMs(PLUGIN, 'route GET:/slow', T0 + 1)).toBe(0)
    recordDispatchOverrun(PLUGIN, 'route GET:/slow', T0 + 1000)
    expect(dispatchCoolOffRemainingMs(PLUGIN, 'route GET:/slow', T0 + 1000)).toBe(15_000)
    expect(dispatchCoolOffRemainingMs(PLUGIN, 'route GET:/slow', T0 + 11_000)).toBe(5_000)
    expect(dispatchCoolOffRemainingMs(PLUGIN, 'route GET:/slow', T0 + 16_000)).toBe(0)
  })

  it('cools off only the route that overran', () => {
    recordDispatchOverrun(PLUGIN, 'route GET:/slow', T0)
    recordDispatchOverrun(PLUGIN, 'route GET:/slow', T0 + 1)
    expect(dispatchCoolOffRemainingMs(PLUGIN, 'route GET:/other', T0 + 2)).toBe(0)
    expect(dispatchCoolOffRemainingMs('acme.elsewhere', 'route GET:/slow', T0 + 2)).toBe(0)
  })

  it('starts over after ten quiet minutes', () => {
    recordDispatchOverrun(PLUGIN, 'route GET:/slow', T0)
    recordDispatchOverrun(PLUGIN, 'route GET:/slow', T0 + 1)
    const later = T0 + 10 * 60_000 + 2
    expect(dispatchCoolOffRemainingMs(PLUGIN, 'route GET:/slow', later)).toBe(0)
    expect(recordDispatchOverrun(PLUGIN, 'route GET:/slow', later)).toBe(0)
  })

  it('is forgotten on a manual restart', () => {
    recordDispatchOverrun(PLUGIN, 'route GET:/slow', T0)
    recordDispatchOverrun(PLUGIN, 'route GET:/slow', T0 + 1)
    clearPluginCrashCounter(PLUGIN)
    expect(dispatchCoolOffRemainingMs(PLUGIN, 'route GET:/slow', T0 + 2)).toBe(0)
  })
})

describe('a dispatch that is cooling off', () => {
  /** A worker that must never be sent anything. */
  function silentWorker(posted: string[]): Worker {
    return {
      postMessage: (msg: { kind: string }) => { posted.push(msg.kind) },
      terminate: () => { /* nothing to stop */ },
      addEventListener: () => { /* injected stub */ },
    } as unknown as Worker
  }

  function coolOff(key: string): void {
    recordDispatchOverrun(PLUGIN, key)
    recordDispatchOverrun(PLUGIN, key)
  }

  it('is not sent, and each kind falls back: filter unchanged, listener skipped, loop and route fail', async () => {
    const posted: string[] = []
    workers.set(PLUGIN, silentWorker(posted))
    hostPlugins.set(PLUGIN, {
      manifest: { id: PLUGIN },
      routes: new Map([['GET:/slow', { access: { kind: 'public' } }]]),
    } as unknown as HostPluginRecord)
    try {
      for (const key of ['filter publish.html', 'listener publish.before', 'loop acme.items', 'route GET:/slow', 'media-url']) {
        coolOff(key)
      }
      const output = watchPluginOutput()

      expect(await runHookFilterInWorker(PLUGIN, 'f1', 'publish.html', '<p>page</p>')).toBe('<p>page</p>')
      await runHookListenerInWorker(PLUGIN, 'l1', 'publish.before', {})
      expect(await runMediaUrlTransformerInWorker(PLUGIN, 't1', {})).toBeNull()
      // An empty list is never offered as the answer: the fetch fails.
      const loop = await runLoopFetchInWorker(PLUGIN, 'acme.items', {}).catch((err: unknown) => err)
      expect((loop as Error).name).toBe('PluginDispatchCoolingOffError')
      const route = await runRouteInWorker({
        pluginId: PLUGIN,
        method: 'GET',
        path: '/slow',
        request: new Request('https://site.example/x'),
        user: null,
        member: null,
      })
      expect(route.status).toBe(503)
      expect(Number(route.headers.get('retry-after'))).toBeGreaterThan(0)

      expect(posted).toEqual([])
      // Whatever was being rendered lacks this plugin's output.
      expect(output.disrupted()).toBe(true)
    } finally {
      workers.delete(PLUGIN)
      hostPlugins.delete(PLUGIN)
    }
  })

  it('keeps a render made meanwhile out of the render cache', async () => {
    resetForTests()
    const posted: string[] = []
    workers.set(PLUGIN, silentWorker(posted))
    try {
      coolOff('filter publish.html')
      let renders = 0
      const render = async () => {
        renders += 1
        const body = await runHookFilterInWorker(PLUGIN, 'f1', 'publish.html', 'unfiltered')
        return { body: String(body), headers: {}, status: 200 as const }
      }
      const key = { urlPath: '/dynamic', queryString: '' }
      expect((await getOrRender(key, render))?.body).toBe('unfiltered')
      // Not kept: the next request renders again.
      await getOrRender(key, render)
      expect(renders).toBe(2)

      // Once the cool-off is over (cleared here) a render is cached as usual.
      clearDispatchCoolOffs(PLUGIN)
      workers.delete(PLUGIN)
      let cleanRenders = 0
      const clean = async () => {
        cleanRenders += 1
        return { body: 'ok', headers: {}, status: 200 as const }
      }
      await getOrRender({ urlPath: '/clean', queryString: '' }, clean)
      await getOrRender({ urlPath: '/clean', queryString: '' }, clean)
      expect(cleanRenders).toBe(1)
    } finally {
      workers.delete(PLUGIN)
      resetForTests()
    }
  })
})

describe('overrun accounting', () => {
  it('never parks the plugin, however many overruns', () => {
    const decisions = Array.from({ length: 50 }, (_, n) => recordCrashAndDecide(PLUGIN, T0 + n * 100, 'overrun'))
    expect(decisions.every((decision) => decision.kind === 'respawn')).toBe(true)
    expect(decisions[49].recentCrashCount).toBe(50)
  })

  it('does not bring a crash any closer to parking', () => {
    for (let n = 0; n < 10; n += 1) recordCrashAndDecide(PLUGIN, T0 + n, 'overrun')
    expect(recordCrashAndDecide(PLUGIN, T0 + 100, 'crash')).toEqual({ kind: 'respawn', recentCrashCount: 1 })
    expect(recordCrashAndDecide(PLUGIN, T0 + 101, 'crash')).toEqual({ kind: 'respawn', recentCrashCount: 2 })
    expect(recordCrashAndDecide(PLUGIN, T0 + 102, 'crash')).toEqual({ kind: 'give-up', recentCrashCount: 3 })
  })
})
