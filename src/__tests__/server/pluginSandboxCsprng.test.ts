/**
 * Plugin sandbox CSPRNG — `crypto.getRandomValues` and `crypto.randomUUID`
 * inside the QuickJS-WASM VM.
 *
 * Before this existed the sandbox exposed only `crypto.subtle` (digest +
 * HMAC), so `Math.random` and `Date` were the only entropy available and a
 * plugin minting a bearer token, nonce or one-time link had no safe way to do
 * it server-side (#387).
 *
 * The load-bearing property is that `getRandomValues` is **synchronous**. The
 * digest/HMAC paths go through `__hostCall`, which returns a VM-side Promise,
 * so entropy needed its own synchronous bridge. Several tests below call it
 * without `await` on purpose to pin that.
 *
 * The plugin has no ambient way to report back except `__hostCall`, so each
 * test records observations through a `test.record` recorder and asserts on
 * the host side.
 */
import { describe, expect, it } from 'bun:test'
import { createPluginVm, type PluginVmEnv } from '../../../server/plugins/quickjs/vm'
import { CRYPTO_RANDOM_BYTES_MAX } from '../../../server/plugins/quickjs/bootstrap/crypto'

interface RecorderEntry {
  target: string
  args: unknown[]
}

function makeRecorderEnv(): { env: PluginVmEnv; recorder: RecorderEntry[] } {
  const recorder: RecorderEntry[] = []
  const env: PluginVmEnv = {
    pluginId: 'acme.csprng',
    manifestVersion: '1.0.0',
    grantedPermissions: [],
    assetBasePath: '/uploads/plugins/acme.csprng/1.0.0',
    settings: {},
    hostCall: async (target, args) => {
      recorder.push({ target, args })
      return null
    },
    log: () => { /* swallow */ },
  }
  return { env, recorder }
}

/** Run a plugin body in a VM and return whatever it recorded. */
async function record(body: string): Promise<unknown[]> {
  const { env, recorder } = makeRecorderEnv()
  const vm = await createPluginVm({
    env,
    pluginSource: `
      ;(function () {
        const __plugin_exports = (globalThis.__plugin_exports = {});
        __plugin_exports.activate = async function activate() {
          ${body}
        };
      })();
    `,
  })
  try {
    await vm.runLifecycle('activate')
    return recorder.filter((e) => e.target === 'test.record').map((e) => e.args[0])
  } finally {
    vm.dispose()
  }
}

describe('plugin sandbox: crypto.getRandomValues', () => {
  it('is present and synchronous — no await needed', async () => {
    const [observed] = await record(`
      const a = new Uint8Array(8);
      const returned = crypto.getRandomValues(a);
      __hostCall('test.record', [{
        type: typeof crypto.getRandomValues,
        // A Promise here would mean it went through __hostCall.
        returnsInputSynchronously: returned === a,
        length: a.length,
      }]);
    `)
    expect(observed).toEqual({ type: 'function', returnsInputSynchronously: true, length: 8 })
  })

  it('actually fills the array with varied bytes', async () => {
    const [observed] = await record(`
      const a = new Uint8Array(64);
      crypto.getRandomValues(a);
      let distinct = {};
      let nonZero = 0;
      for (let i = 0; i < a.length; i++) {
        distinct[a[i]] = true;
        if (a[i] !== 0) nonZero++;
      }
      __hostCall('test.record', [{
        distinctCount: Object.keys(distinct).length,
        nonZero: nonZero,
      }]);
    `)
    const stats = observed as { distinctCount: number; nonZero: number }
    // 64 CSPRNG bytes essentially never collapse to a handful of values, and
    // an all-zero fill is the signature of a bridge that silently no-ops.
    expect(stats.nonZero).toBeGreaterThan(50)
    expect(stats.distinctCount).toBeGreaterThan(20)
  })

  it('produces different bytes on successive calls', async () => {
    const [observed] = await record(`
      const a = new Uint8Array(32);
      const b = new Uint8Array(32);
      crypto.getRandomValues(a);
      crypto.getRandomValues(b);
      let same = true;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
      __hostCall('test.record', [{ identical: same }]);
    `)
    expect(observed).toEqual({ identical: false })
  })

  it('fills wider element types across their full byte length', async () => {
    const [observed] = await record(`
      const u32 = new Uint32Array(8);
      crypto.getRandomValues(u32);
      let nonZero = 0;
      for (let i = 0; i < u32.length; i++) if (u32[i] !== 0) nonZero++;
      __hostCall('test.record', [{ byteLength: u32.byteLength, nonZero: nonZero }]);
    `)
    const stats = observed as { byteLength: number; nonZero: number }
    expect(stats.byteLength).toBe(32)
    expect(stats.nonZero).toBeGreaterThan(6)
  })

  it('respects byteOffset when handed a view over a larger buffer', async () => {
    const [observed] = await record(`
      const buf = new ArrayBuffer(16);
      const whole = new Uint8Array(buf);
      const middle = new Uint8Array(buf, 4, 8);
      crypto.getRandomValues(middle);
      let headTouched = false, tailTouched = false;
      for (let i = 0; i < 4; i++) if (whole[i] !== 0) headTouched = true;
      for (let i = 12; i < 16; i++) if (whole[i] !== 0) tailTouched = true;
      let filledNonZero = 0;
      for (let i = 4; i < 12; i++) if (whole[i] !== 0) filledNonZero++;
      __hostCall('test.record', [{ headTouched, tailTouched, filledNonZero }]);
    `)
    const stats = observed as { headTouched: boolean; tailTouched: boolean; filledNonZero: number }
    // Writing outside the view would corrupt neighbouring data.
    expect(stats.headTouched).toBe(false)
    expect(stats.tailTouched).toBe(false)
    expect(stats.filledNonZero).toBeGreaterThan(4)
  })

  it('returns a zero-length array untouched', async () => {
    const [observed] = await record(`
      const a = new Uint8Array(0);
      const returned = crypto.getRandomValues(a);
      __hostCall('test.record', [{ same: returned === a, length: a.length }]);
    `)
    expect(observed).toEqual({ same: true, length: 0 })
  })

  it('throws QuotaExceededError above the WebCrypto ceiling', async () => {
    const [observed] = await record(`
      let name = null;
      try {
        crypto.getRandomValues(new Uint8Array(${CRYPTO_RANDOM_BYTES_MAX} + 1));
      } catch (err) {
        name = err.name;
      }
      __hostCall('test.record', [{ name: name }]);
    `)
    expect(observed).toEqual({ name: 'QuotaExceededError' })
  })

  it('accepts exactly the ceiling', async () => {
    const [observed] = await record(`
      let ok = false;
      try {
        const a = new Uint8Array(${CRYPTO_RANDOM_BYTES_MAX});
        crypto.getRandomValues(a);
        ok = a[0] !== undefined;
      } catch (err) { ok = false; }
      __hostCall('test.record', [{ ok: ok }]);
    `)
    expect(observed).toEqual({ ok: true })
  })

  it('throws TypeMismatchError for float views and non-views', async () => {
    const [observed] = await record(`
      function nameOf(fn) {
        try { fn(); return null; } catch (err) { return err.name; }
      }
      __hostCall('test.record', [{
        float32: nameOf(function () { crypto.getRandomValues(new Float32Array(4)); }),
        float64: nameOf(function () { crypto.getRandomValues(new Float64Array(4)); }),
        plainArray: nameOf(function () { crypto.getRandomValues([1, 2, 3]); }),
        nothing: nameOf(function () { crypto.getRandomValues(); }),
      }]);
    `)
    expect(observed).toEqual({
      float32: 'TypeMismatchError',
      float64: 'TypeMismatchError',
      plainArray: 'TypeMismatchError',
      nothing: 'TypeMismatchError',
    })
  })

  it('does not disturb the existing crypto.subtle surface', async () => {
    const [observed] = await record(`
      __hostCall('test.record', [{
        digest: typeof crypto.subtle.digest,
        importKey: typeof crypto.subtle.importKey,
        sign: typeof crypto.subtle.sign,
      }]);
    `)
    expect(observed).toEqual({ digest: 'function', importKey: 'function', sign: 'function' })
  })
})

describe('plugin sandbox: crypto.randomUUID', () => {
  it('returns a well-formed v4 UUID synchronously', async () => {
    const [observed] = await record(`
      const id = crypto.randomUUID();
      __hostCall('test.record', [{ id: id, type: typeof id }]);
    `)
    const { id, type } = observed as { id: string; type: string }
    expect(type).toBe('string')
    // Version 4, RFC 9562 variant 10xx.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('does not repeat across many calls', async () => {
    const [observed] = await record(`
      const seen = {};
      let collisions = 0;
      for (let i = 0; i < 200; i++) {
        const id = crypto.randomUUID();
        if (seen[id]) collisions++;
        seen[id] = true;
      }
      __hostCall('test.record', [{ collisions: collisions, unique: Object.keys(seen).length }]);
    `)
    expect(observed).toEqual({ collisions: 0, unique: 200 })
  })
})
