/**
 * Sandbox hang hardening — wall-clock deadlines on EVERY way plugin code can
 * execute inside the QuickJS VM, and VM stack preservation.
 *
 * Three hang vectors existed before these guards:
 *   1. Top-level plugin code ran with no interrupt deadline — a bundle with
 *      `while (true) {}` at module top level wedged the worker forever.
 *   2. Concurrent evals on one context clobbered each other's deadline: each
 *      eval overwrote the runtime's single interrupt handler and the first
 *      eval to finish removed it, leaving any still-running eval unguarded.
 *      Fixed by the per-runtime deadline registry in `quickjs/eval.ts`.
 *   3. Timer-callback pumps (`__hostSleep` resolutions) drove
 *      `executePendingJobs()` with no deadline — `setTimeout(() => {
 *      while (true) {} })` wedged the worker permanently.
 *
 * Separately, rejected VM promises used to be re-thrown as bare
 * `new Error(message)`, discarding the QuickJS stack (whose frames carry the
 * useful `plugin:<id>` filename). `PluginVmError` now preserves it.
 */
import { describe, expect, it } from 'bun:test'
import { createPluginVm, type PluginVmEnv } from '../../../server/plugins/quickjs/vm'
import { PluginCallBudgetError, PluginVmError, vmStackOf } from '../../../server/plugins/quickjs/eval'
import { DEFAULT_RPC_TIMEOUT_MS } from '../../../server/plugins/host/workerPool'
import { DEFAULT_PLUGIN_FETCH_TIMEOUT_MS, PLUGIN_CALL_BUDGET_MS } from '../../../server/plugins/quickjs/limits'

function makeEnv(pluginId: string): PluginVmEnv {
  return {
    pluginId,
    manifestVersion: '1.0.0',
    grantedPermissions: ['cms.schedule'],
    assetBasePath: `/uploads/plugins/${pluginId}/1.0.0`,
    settings: {},
    hostCall: async () => null,
    log: () => { /* swallow */ },
  }
}

describe('plugin sandbox: eval deadlines', () => {
  it('aborts a top-level infinite loop at load time instead of hanging', async () => {
    const t0 = Date.now()
    await expect(
      createPluginVm({
        env: makeEnv('acme.spinner'),
        evalTimeoutMs: 300,
        pluginSource: 'globalThis.__plugin_exports = {}; while (true) {}',
      }),
    ).rejects.toThrow(/interrupted/i)
    // Interrupted within the deadline (+ slack), not after a worker hang.
    expect(Date.now() - t0).toBeLessThan(3_000)
  }, 10_000)

  it('keeps the deadline armed for an eval that outlives an overlapping eval', async () => {
    // `fast` finishes while `spin` is still pending. With the old
    // install/remove interrupt-handler pair, fast's `finally` stripped the
    // handler from the runtime and spin's later `while (true) {}` ran with
    // NO deadline — wedging the thread forever. The deadline registry keeps
    // one persistent handler armed until the LAST active deadline releases.
    const vm = await createPluginVm({
      env: makeEnv('acme.overlap'),
      evalTimeoutMs: 400,
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = async function activate(api) {
            api.cms.schedule.every(5, 'fast', async function () {
              await new Promise(function (r) { setTimeout(r, 20); });
            });
            api.cms.schedule.every(5, 'spin', async function () {
              await new Promise(function (r) { setTimeout(r, 60); });
              while (true) {}
            });
          };
        })();
      `,
    })
    try {
      await vm.runLifecycle('activate')
      const spin = vm.runSchedule('acme.overlap.spin', 400)
      const fast = vm.runSchedule('acme.overlap.fast', 400)
      await fast // must NOT strip spin's deadline when it completes
      await expect(spin).rejects.toThrow(/interrupted/i)
    } finally {
      vm.dispose()
    }
  }, 10_000)

  it('interrupts a runaway timer callback and keeps the VM usable', async () => {
    // The `while (true) {}` runs inside the __hostSleep timer pump — long
    // after the eval that scheduled it resolved, so no eval deadline covers
    // it. The pump's own deadline must abort it and the VM must survive.
    const vm = await createPluginVm({
      env: makeEnv('acme.timerspin'),
      evalTimeoutMs: 150,
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = function activate() {
            setTimeout(function () { while (true) {} }, 20);
          };
        })();
      `,
    })
    try {
      await vm.runLifecycle('activate')
      // Let the timer fire and the pump interrupt it (deadline 150ms).
      await new Promise((res) => setTimeout(res, 300))
      // The VM is still serviceable after the aborted pump.
      await vm.updateSettings({ stillAlive: true })
    } finally {
      vm.dispose()
    }
  }, 10_000)
})

describe('plugin sandbox: wall-clock call budget', () => {
  /**
   * `deactivate` awaits far past any budget used here; `quick` and `steady`
   * are schedules, which bring their own budget (`maxDurationMs`).
   */
  const SOURCE = `
    ;(function () {
      const __plugin_exports = (globalThis.__plugin_exports = {});
      function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
      __plugin_exports.activate = async function activate(api) {
        api.cms.schedule.every(5, 'quick', async function () { await sleep(20); });
        api.cms.schedule.every(5, 'steady', async function () { await sleep(250); });
        api.cms.schedule.every(5, 'stuck', async function () { await sleep(60000); });
      };
      __plugin_exports.deactivate = async function deactivate() { await sleep(60000); };
      __plugin_exports.install = async function install() {
        await sleep(80); await sleep(80); await sleep(80);
      };
    })();
  `

  it('fails a call still awaiting after its budget, alone, and leaves the VM usable', async () => {
    const vm = await createPluginVm({ env: makeEnv('acme.budget'), callBudgetMs: 150, pluginSource: SOURCE })
    try {
      await vm.runLifecycle('activate')
      const t0 = Date.now()
      const slow = vm.runLifecycle('deactivate').catch((err: unknown) => err)
      // A sibling call in flight on the same VM is not taken down with it.
      await vm.runSchedule('acme.budget.quick', 1_000)
      const failure = await slow
      expect(failure).toBeInstanceOf(PluginCallBudgetError)
      expect((failure as Error).message).toBe('Plugin call exceeded its 0.15s time budget')
      // Noticed at the budget (plus the re-check interval), not after a hang.
      expect(Date.now() - t0).toBeLessThan(1_500)
      // The VM carries on serving calls afterwards.
      await vm.runSchedule('acme.budget.quick', 1_000)
    } finally {
      vm.dispose()
    }
  }, 10_000)

  it('does not count awaited time against the execution deadline', async () => {
    // Three 80 ms awaits outlast the 100 ms execution deadline but fit the budget.
    const vm = await createPluginVm({
      env: makeEnv('acme.awaits'),
      evalTimeoutMs: 100,
      callBudgetMs: 5_000,
      pluginSource: SOURCE,
    })
    try {
      await vm.runLifecycle('install')
    } finally {
      vm.dispose()
    }
  }, 10_000)

  it("bounds a schedule fire by its own maxDurationMs, not the default budget", async () => {
    const vm = await createPluginVm({ env: makeEnv('acme.sched'), callBudgetMs: 100, pluginSource: SOURCE })
    try {
      await vm.runLifecycle('activate')
      // Longer than the 100 ms default budget, inside its own 2 s.
      await vm.runSchedule('acme.sched.steady', 2_000)
      // Still awaiting after its own 150 ms.
      await expect(vm.runSchedule('acme.sched.stuck', 150)).rejects.toThrow(
        'Plugin call exceeded its 0.15s time budget',
      )
    } finally {
      vm.dispose()
    }
  }, 10_000)

  /** A VM whose `network.fetch` host call behaves like `handler`, recording each init. */
  async function fetchVm(
    pluginId: string,
    callBudgetMs: number,
    handler: (init: { timeoutMs: number }) => Promise<unknown>,
    body: string,
  ) {
    const fetches: Array<{ timeoutMs: number; at: number }> = []
    const env = makeEnv(pluginId)
    env.grantedPermissions = ['cms.schedule', 'network.outbound']
    env.hostCall = async (target, args) => {
      if (target !== 'network.fetch') return null
      const init = args[1] as { timeoutMs: number }
      fetches.push({ timeoutMs: init.timeoutMs, at: Date.now() })
      return handler(init)
    }
    const vm = await createPluginVm({
      env,
      callBudgetMs,
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
          ${body}
        })();
      `,
    })
    return { vm, fetches }
  }
  const answers = async () => ({ status: 200, ok: true, headers: {}, body: 'ok', bodyEncoding: 'utf8' })
  /** A host that is down: the request runs for its whole timeout, then times out. */
  const dead = async (init: { timeoutMs: number }) => {
    await new Promise((res) => setTimeout(res, init.timeoutMs))
    throw Object.assign(new Error('Plugin "x" fetch timed out'), { code: 'fetch_timeout' })
  }

  it('gives a request the time left in the call less a handling margin', async () => {
    const { vm, fetches } = await fetchVm('acme.clamp', 4_000, answers, `
      __plugin_exports.activate = async function activate(api) {
        api.cms.schedule.every(5, 'job', async function () {
          await fetch('https://api.example.com/c', { timeout: 250000 });
        });
      };
      __plugin_exports.install = async function install() {
        await fetch('https://api.example.com/a', { timeout: 60000 });
        await fetch('https://api.example.com/b', { timeout: 300 });
      };
    `)
    try {
      await vm.runLifecycle('install')
      await vm.runLifecycle('activate')
      await vm.runSchedule('acme.clamp.job', 1_200)
    } finally {
      vm.dispose()
    }
    const [long, short, scheduled] = fetches.map((f) => f.timeoutMs)
    // 4 s budget keeps a 1 s margin: at most 3 s for the request.
    expect(long).toBeGreaterThan(2_000)
    expect(long).toBeLessThanOrEqual(3_000)
    // Shorter than what is left: kept.
    expect(short).toBe(300)
    // A schedule's remainder is its own maxDurationMs, margin capped at half.
    expect(scheduled).toBeLessThanOrEqual(600)
  }, 10_000)

  it('a dead upstream gives the handler catchable timeouts, never an overrun', async () => {
    const { vm, fetches } = await fetchVm('acme.dead', 1_500, dead, `
      __plugin_exports.install = async function install() {
        const seen = [];
        for (const path of ['/one', '/two']) {
          try { await fetch('https://down.example.com' + path); seen.push('answered'); }
          catch (e) { seen.push(e.name); }
        }
        if (seen.join() !== 'TimeoutError,TimeoutError') throw new Error('unexpected: ' + seen.join());
      };
    `)
    try {
      const t0 = Date.now()
      // Resolves: both failures were caught and handled inside the budget.
      await vm.runLifecycle('install')
      expect(Date.now() - t0).toBeLessThan(1_400)
    } finally {
      vm.dispose()
    }
    // The first request got the budget less the margin; the second had too
    // little left and was refused without going out.
    expect(fetches).toHaveLength(1)
    expect(fetches[0].timeoutMs).toBeLessThanOrEqual(750)
  }, 10_000)

  it('bounds a request by the tightest call in flight, not the longest', async () => {
    const { vm, fetches } = await fetchVm('acme.tight', 800, answers, `
      __plugin_exports.activate = async function activate(api) {
        api.cms.schedule.every(5, 'long', async function () { await sleep(700); });
      };
      __plugin_exports.install = async function install() {
        await fetch('https://api.example.com/route');
      };
    `)
    try {
      await vm.runLifecycle('activate')
      const long = vm.runSchedule('acme.tight.long', 4_000)
      await new Promise((res) => setTimeout(res, 50))
      // An 800 ms call starts while a 4 s schedule is in flight.
      await vm.runLifecycle('install')
      await long
    } finally {
      vm.dispose()
    }
    // Bounded by the 800 ms call (400 ms margin), not by the schedule's 4 s.
    expect(fetches[0].timeoutMs).toBeLessThanOrEqual(400)
  }, 10_000)

  it('keeps the budget below the worker RPC timeout, with room for one timed-out request', () => {
    // Above the RPC timeout a slow handler would take the whole worker (and
    // its sibling calls) down instead of failing on its own.
    expect(PLUGIN_CALL_BUDGET_MS).toBeLessThan(DEFAULT_RPC_TIMEOUT_MS)
    expect(DEFAULT_PLUGIN_FETCH_TIMEOUT_MS).toBeLessThan(PLUGIN_CALL_BUDGET_MS)
  })
})

describe('plugin sandbox: VM stack preservation', () => {
  it('preserves the VM stack with the plugin:<id> filename on thrown errors', async () => {
    const vm = await createPluginVm({
      env: makeEnv('acme.stacky'),
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = async function activate() {
            throw new Error('activation exploded');
          };
        })();
      `,
    })
    try {
      const err = await vm.runLifecycle('activate').then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(PluginVmError)
      const vmErr = err as PluginVmError
      // Message stays clean — it travels into API replies / error envelopes.
      expect(vmErr.message).toBe('activation exploded')
      // The QuickJS frames name the plugin bundle's eval filename.
      expect(vmErr.vmStack).toContain('plugin:acme.stacky')
      // `.stack` shows the VM frames so `[plugin:<id>]` logs print them.
      expect(vmErr.stack).toContain('activation exploded')
      expect(vmErr.stack).toContain('plugin:acme.stacky')
      expect(vmStackOf(err)).toBe(vmErr.vmStack)
    } finally {
      vm.dispose()
    }
  })

  it('extracts the VM stack from synchronous top-level eval errors', async () => {
    // Synchronous throws surface through `ctx.unwrapResult` as
    // QuickJSUnwrapError, which carries the dumped VM error as `cause` —
    // vmStackOf must read the frames from there too.
    const err = await createPluginVm({
      env: makeEnv('acme.boom'),
      pluginSource: 'globalThis.__plugin_exports = {};\nthrow new Error(\'top-level boom\');',
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('top-level boom')
    expect(vmStackOf(err)).toContain('plugin:acme.boom')
  })
})
