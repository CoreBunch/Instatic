/**
 * Plugin system benchmark.
 *
 * Plugins are server-side code that runs inside a QuickJS-WASM sandbox.
 * The boundary cost matters: every plugin install spins up a fresh VM,
 * every `hostCall` crosses the JS ↔ sandbox bridge, and every plugin
 * route is a VM evaluation followed by host RPC.
 *
 * Scenarios:
 *   - Cold VM boot: how long from `createPluginVm` to first lifecycle
 *     hook? This is paid on plugin activation.
 *   - Host call roundtrip: how expensive is `__hostCall(target, args)`?
 *     Every plugin/host RPC pays this cost.
 *   - Lifecycle hook (activate) under a no-op plugin: minimal overhead floor.
 *   - Hook-filter payload sweep: `runHookFilter` through an identity filter
 *     at 1 KB / 100 KB / 1 MB payloads — isolates the host→VM→host payload
 *     marshaling cost that `publish.html` filters pay on whole-page HTML.
 *   - bodyEncoding base64 codec: encode/decode 1 MB / 10 MB of binary
 *     bytes — the cost every binary body pays when crossing the bridge.
 *   - VM dispose: how long does teardown take? Matters for short-lived
 *     plugins or those that are uninstalled often.
 */
import { performance } from 'node:perf_hooks'
import type { BenchModule, BenchResult, BenchRow, BenchContext } from '../lib/types'
import { summarize, fmtMs, fmtNum, fmtBytes } from '../lib/stats'
import { log } from '../lib/log'

interface RecorderEntry {
  target: string
  args: unknown[]
}

async function loadVm() {
  const { createPluginVm } = await import('../../../server/plugins/quickjs/vm')
  return { createPluginVm }
}

function makeEnv(recorder: RecorderEntry[]): {
  pluginId: string
  manifestVersion: string
  grantedPermissions: string[]
  assetBasePath: string
  settings: Record<string, string | number | boolean>
  hostCall: (target: string, args: unknown[]) => Promise<unknown>
  log: (args: unknown[]) => void
} {
  return {
    pluginId: 'bench.plugin',
    manifestVersion: '1.0.0',
    grantedPermissions: [],
    assetBasePath: '/uploads/plugins/bench.plugin/1.0.0',
    settings: {},
    hostCall: async (target, args) => {
      recorder.push({ target, args })
      return null
    },
    log: () => {
      /* swallow */
    },
  }
}

const NO_OP_SOURCE = `
  ;(function () {
    const __plugin_exports = (globalThis.__plugin_exports = {});
    __plugin_exports.activate = async function activate() { /* noop */ };
    __plugin_exports.deactivate = async function deactivate() { /* noop */ };
  })();
`

// Plugin that invokes hostCall in a tight loop — used to measure
// roundtrip cost of the JS ↔ sandbox bridge.
const ROUNDTRIP_SOURCE = `
  ;(function () {
    const __plugin_exports = (globalThis.__plugin_exports = {});
    __plugin_exports.activate = async function activate() {
      const N = parseInt(globalThis.__bench_n || '100');
      for (let i = 0; i < N; i++) {
        await __hostCall('test.ping', [i]);
      }
    };
  })();
`

// Plugin with an identity hook filter wired straight into the bootstrap
// registry — `runHookFilter` round-trips the payload host→VM→host while the
// handler itself does zero work, so the measurement isolates pure payload
// marshaling (the cost a `publish.html` filter pays on full-page HTML).
const IDENTITY_FILTER_SOURCE = `
  ;(function () {
    const __plugin_exports = (globalThis.__plugin_exports = {});
    __plugin_exports.activate = async function activate() { /* noop */ };
    globalThis.__plugin_handlers.filters['bench.identity'] = function (value) { return value; };
  })();
`

/**
 * Deterministic HTML-ish payload of exactly `size` chars. Includes quotes
 * and backslashes so the JSON-escaping passes in the marshaling path do
 * realistic work.
 */
function makeHtmlPayload(size: number): string {
  const unit = '<section class="hero" data-x="1">Hello "quoted" \\ text — payload</section>\n'
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size)
}

/** Deterministic pseudo-random bytes (xorshift32) — stable across runs. */
function makeRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  let state = 0x9e3779b9
  for (let i = 0; i < size; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[i] = state & 0xff
  }
  return bytes
}

export const pluginBench: BenchModule = {
  name: 'plugin',
  title: 'Plugin sandbox (QuickJS)',
  description: 'Cold VM boot, host-call roundtrip cost, lifecycle hook latency, dispose timing.',

  async run(ctx: BenchContext): Promise<BenchResult> {
    const { createPluginVm } = await loadVm()

    // ---- Cold VM boot --------------------------------------------------
    log.step('Cold VM boot timing')
    const bootRows: BenchRow[] = []
    {
      const iters = ctx.quick ? 5 : 20
      const samples: number[] = []
      for (let i = 0; i < iters; i++) {
        const recorder: RecorderEntry[] = []
        const env = makeEnv(recorder)
        const t0 = performance.now()
        const vm = await createPluginVm({ env, pluginSource: NO_OP_SOURCE })
        samples.push(performance.now() - t0)
        vm.dispose()
      }
      const s = summarize(samples)
      bootRows.push({
        label: 'createPluginVm → ready',
        inputs: { iters },
        metrics: {
          mean: fmtMs(s.mean),
          p50: fmtMs(s.p50),
          p95: fmtMs(s.p95),
          p99: fmtMs(s.p99),
          min: fmtMs(s.min),
          max: fmtMs(s.max),
        },
      })
    }

    // ---- Lifecycle hook (activate, no-op) ------------------------------
    log.step('No-op activate hook latency')
    const lifecycleRows: BenchRow[] = []
    {
      const recorder: RecorderEntry[] = []
      const env = makeEnv(recorder)
      const vm = await createPluginVm({ env, pluginSource: NO_OP_SOURCE })
      try {
        const iters = ctx.quick ? 50 : 200
        // Warmup
        await vm.runLifecycle('activate')
        const samples: number[] = []
        for (let i = 0; i < iters; i++) {
          const t0 = performance.now()
          await vm.runLifecycle('activate')
          samples.push(performance.now() - t0)
        }
        const s = summarize(samples)
        lifecycleRows.push({
          label: 'activate (no-op body)',
          inputs: { iters },
          metrics: {
            mean: fmtMs(s.mean),
            p50: fmtMs(s.p50),
            p95: fmtMs(s.p95),
            p99: fmtMs(s.p99),
          },
        })
      } finally {
        vm.dispose()
      }
    }

    // ---- Host call roundtrip -------------------------------------------
    log.step('hostCall roundtrip cost (sandbox ↔ host)')
    const roundtripRows: BenchRow[] = []
    {
      const sizes = ctx.quick ? [100] : [100, 1_000, 10_000]
      for (const n of sizes) {
        const recorder: RecorderEntry[] = []
        const env = makeEnv(recorder)
        // Set the iteration count via a sneaky globalThis read inside the VM:
        // we use a per-VM wrapper that injects __bench_n before evaluating the
        // user source. Easiest is to inline the count into the source.
        const source = ROUNDTRIP_SOURCE.replace(
          "globalThis.__bench_n || '100'",
          `'${n}'`,
        )
        const vm = await createPluginVm({ env, pluginSource: source })
        try {
          // Warmup
          await vm.runLifecycle('activate')
          recorder.length = 0
          const t0 = performance.now()
          await vm.runLifecycle('activate')
          const wallMs = performance.now() - t0
          if (recorder.length !== n) {
            throw new Error(`expected ${n} host calls, got ${recorder.length}`)
          }
          roundtripRows.push({
            label: `${fmtNum(n)} hostCall(target, args) round-trips`,
            inputs: { calls: n },
            metrics: {
              wall: fmtMs(wallMs),
              per_call: fmtMs(wallMs / n),
              throughput: `${fmtNum(Math.floor((n / wallMs) * 1000))} calls/s`,
            },
          })
        } finally {
          vm.dispose()
        }
      }
    }

    // ---- Hook-filter payload marshaling sweep ---------------------------
    log.step('runHookFilter payload-size sweep (identity filter)')
    const filterPayloadRows: BenchRow[] = []
    {
      const recorder: RecorderEntry[] = []
      const env = makeEnv(recorder)
      const vm = await createPluginVm({ env, pluginSource: IDENTITY_FILTER_SOURCE })
      try {
        const sweep: Array<{ size: number; iters: number }> = [
          { size: 1_024, iters: ctx.quick ? 20 : 50 },
          { size: 100 * 1_024, iters: ctx.quick ? 10 : 30 },
          { size: 1_024 * 1_024, iters: ctx.quick ? 5 : 15 },
        ]
        for (const { size, iters } of sweep) {
          const payload = makeHtmlPayload(size)
          // Warmup + correctness check: the identity filter must round-trip
          // the payload byte-exactly or the marshaling path is broken.
          const echoed = await vm.runHookFilter('bench.identity', payload)
          if (echoed !== payload) {
            throw new Error(`identity filter did not round-trip a ${size}-char payload`)
          }
          const samples: number[] = []
          for (let i = 0; i < iters; i++) {
            const t0 = performance.now()
            await vm.runHookFilter('bench.identity', payload)
            samples.push(performance.now() - t0)
          }
          const s = summarize(samples)
          filterPayloadRows.push({
            label: `runHookFilter identity, ${fmtBytes(size)} payload`,
            inputs: { bytes: size, iters },
            metrics: {
              mean: fmtMs(s.mean),
              p50: fmtMs(s.p50),
              p95: fmtMs(s.p95),
              max: fmtMs(s.max),
              throughput: `${(size / 1024 / 1024 / (s.mean / 1000)).toFixed(1)} MB/s`,
            },
          })
        }
      } finally {
        vm.dispose()
      }
    }

    // ---- bodyEncoding base64 codec ---------------------------------------
    log.step('bodyEncoding base64 encode/decode')
    const base64Rows: BenchRow[] = []
    {
      const { bytesToBase64, base64ToBytes } = await import(
        '../../../server/plugins/protocol/bodyEncoding'
      )
      const sweep: Array<{ size: number; iters: number }> = [
        { size: 1_024 * 1_024, iters: ctx.quick ? 5 : 20 },
        { size: 10 * 1_024 * 1_024, iters: ctx.quick ? 3 : 10 },
      ]
      for (const { size, iters } of sweep) {
        const bytes = makeRandomBytes(size)
        // Warmup + correctness check.
        const warmEncoded = bytesToBase64(bytes)
        const warmDecoded = base64ToBytes(warmEncoded)
        if (warmDecoded.length !== bytes.length || warmDecoded[0] !== bytes[0] || warmDecoded[size - 1] !== bytes[size - 1]) {
          throw new Error(`base64 round-trip mismatch at ${size} bytes`)
        }
        const encodeSamples: number[] = []
        for (let i = 0; i < iters; i++) {
          const t0 = performance.now()
          bytesToBase64(bytes)
          encodeSamples.push(performance.now() - t0)
        }
        const decodeSamples: number[] = []
        for (let i = 0; i < iters; i++) {
          const t0 = performance.now()
          base64ToBytes(warmEncoded)
          decodeSamples.push(performance.now() - t0)
        }
        const enc = summarize(encodeSamples)
        const dec = summarize(decodeSamples)
        base64Rows.push({
          label: `base64 codec, ${fmtBytes(size)}`,
          inputs: { bytes: size, iters },
          metrics: {
            encode_mean: fmtMs(enc.mean),
            decode_mean: fmtMs(dec.mean),
            encode_throughput: `${(size / 1024 / 1024 / (enc.mean / 1000)).toFixed(0)} MB/s`,
            decode_throughput: `${(size / 1024 / 1024 / (dec.mean / 1000)).toFixed(0)} MB/s`,
          },
        })
      }
    }

    // ---- VM dispose ----------------------------------------------------
    log.step('VM dispose timing')
    const disposeRows: BenchRow[] = []
    {
      const iters = ctx.quick ? 10 : 50
      const samples: number[] = []
      for (let i = 0; i < iters; i++) {
        const recorder: RecorderEntry[] = []
        const env = makeEnv(recorder)
        const vm = await createPluginVm({ env, pluginSource: NO_OP_SOURCE })
        const t0 = performance.now()
        vm.dispose()
        samples.push(performance.now() - t0)
      }
      const s = summarize(samples)
      disposeRows.push({
        label: 'vm.dispose()',
        inputs: { iters },
        metrics: {
          mean: fmtMs(s.mean),
          p50: fmtMs(s.p50),
          p95: fmtMs(s.p95),
          max: fmtMs(s.max),
        },
      })
    }

    return {
      name: this.name,
      title: this.title,
      headline: {
        'cold VM boot p95': bootRows[0].metrics.p95,
        'activate (no-op) mean': lifecycleRows[0].metrics.mean,
        'hostCall (per call)': roundtripRows[0]?.metrics.per_call ?? '—',
        'hookFilter 1 MB payload mean': filterPayloadRows[2]?.metrics.mean ?? '—',
        'base64 encode 10 MB mean': base64Rows[1]?.metrics.encode_mean ?? '—',
      },
      sections: [
        {
          title: 'Cold VM boot (createPluginVm)',
          intro: 'Paid on every plugin activation. Includes WASM module init + context creation + plugin source eval.',
          rows: bootRows,
        },
        {
          title: 'Lifecycle hook latency (no-op activate)',
          intro: 'Minimum cost of crossing the sandbox boundary for an explicit lifecycle hook.',
          rows: lifecycleRows,
        },
        {
          title: 'hostCall roundtrip',
          intro:
            'Cost of one round-trip from the QuickJS sandbox to the host and back. Drives latency of any plugin → CMS API call.',
          rows: roundtripRows,
        },
        {
          title: 'runHookFilter payload sweep (identity filter)',
          intro:
            'Host→VM→host marshaling cost as the payload grows. A `publish.html` filter carries the entire rendered page HTML through this path on every Layer B cache miss and publish bake.',
          rows: filterPayloadRows,
        },
        {
          title: 'bodyEncoding base64 codec',
          intro:
            'Encode/decode cost for binary bodies crossing the sandbox bridge (route uploads, binary fetch responses, media adapters).',
          rows: base64Rows,
        },
        {
          title: 'VM dispose',
          intro: 'Tear-down cost. Paid on plugin deactivation / uninstall / worker crash recovery.',
          rows: disposeRows,
        },
      ],
    }
  },
}
