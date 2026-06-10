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
import { PluginVmError, vmStackOf } from '../../../server/plugins/quickjs/eval'

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
