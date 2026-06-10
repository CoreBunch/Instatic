/**
 * Binary safety inside the QuickJS plugin sandbox — the VM side of the wire
 * format pinned by `src/__tests__/plugins/pluginBinaryIo.test.ts`.
 *
 * fetch shim: `arrayBuffer()` must return the exact upstream bytes (the old
 * shim re-encoded with `charCodeAt(i) & 0xff`, garbling anything the host's
 * lossy `text()` read had already mangled), `text()`/`json()` must decode
 * UTF-8 (including multibyte), binary request bodies must reach the host
 * base64-tagged, and unsupported body types (FormData & co.) must throw a
 * TypeError instead of silently stringifying.
 *
 * route runner: the raw body decodes byte-exactly via `req.arrayBuffer()`,
 * multipart file markers materialize into file facades, and binary
 * `__response` bodies leave the VM base64-tagged.
 */
import { describe, expect, it } from 'bun:test'
import { createPluginVm, type PluginVmEnv } from '../../../server/plugins/quickjs/vm'
import { base64ToBytes, bytesToBase64 } from '../../../server/plugins/protocol/bodyEncoding'

interface RecorderEntry {
  target: string
  args: unknown[]
}

function makeRecorderEnv(overrides: {
  recorder?: RecorderEntry[]
  onCall?: (target: string, args: unknown[]) => Promise<unknown> | unknown
  grantedPermissions?: string[]
} = {}): { env: PluginVmEnv; recorder: RecorderEntry[] } {
  const recorder = overrides.recorder ?? []
  const env: PluginVmEnv = {
    pluginId: 'acme.binary',
    manifestVersion: '1.0.0',
    grantedPermissions: overrides.grantedPermissions ?? [],
    assetBasePath: '/uploads/plugins/acme.binary/1.0.0',
    settings: {},
    hostCall: async (target, args) => {
      recorder.push({ target, args })
      if (overrides.onCall) return await overrides.onCall(target, args)
      return null
    },
    log: () => { /* swallow */ },
  }
  return { env, recorder }
}

/** PNG signature + a NUL and >0x7f bytes — NOT valid UTF-8. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x7f])

const MULTIBYTE_TEXT = 'řeřicha 🌱 — ユニコード'

describe('plugin sandbox: fetch — binary bodies', () => {
  it('arrayBuffer() returns the exact upstream bytes for a base64 response', async () => {
    const { env, recorder } = makeRecorderEnv({
      onCall: (target) => {
        if (target === 'network.fetch') {
          return {
            status: 200,
            ok: true,
            headers: { 'content-type': 'image/png' },
            body: bytesToBase64(PNG_BYTES),
            bodyEncoding: 'base64',
          }
        }
        return null
      },
    })
    const vm = await createPluginVm({
      env,
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = async function activate() {
            const res = await fetch('https://cdn.example.com/pixel.png');
            const bytes = new Uint8Array(await res.arrayBuffer());
            await __hostCall('test.record', [Array.from(bytes)]);
          };
        })();
      `,
    })
    try {
      await vm.runLifecycle('activate')
      const observed = recorder.find((e) => e.target === 'test.record')?.args[0]
      expect(observed).toEqual(Array.from(PNG_BYTES))
    } finally {
      vm.dispose()
    }
  })

  it('text() and json() decode UTF-8 (incl. multibyte) for both encodings', async () => {
    const jsonPayload = JSON.stringify({ note: MULTIBYTE_TEXT })
    const { env, recorder } = makeRecorderEnv({
      onCall: (target, args) => {
        if (target === 'network.fetch') {
          const url = String(args[0])
          // /base64 carries the SAME text base64-encoded; /utf8 carries it verbatim.
          return url.endsWith('/base64')
            ? { status: 200, ok: true, headers: {}, body: bytesToBase64(new TextEncoder().encode(jsonPayload)), bodyEncoding: 'base64' }
            : { status: 200, ok: true, headers: {}, body: jsonPayload, bodyEncoding: 'utf8' }
        }
        return null
      },
    })
    const vm = await createPluginVm({
      env,
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = async function activate() {
            const a = await (await fetch('https://api.example.com/utf8')).text();
            const b = await (await fetch('https://api.example.com/base64')).text();
            const c = await (await fetch('https://api.example.com/base64')).json();
            await __hostCall('test.record', [a, b, c.note]);
          };
        })();
      `,
    })
    try {
      await vm.runLifecycle('activate')
      const observed = recorder.find((e) => e.target === 'test.record')?.args
      expect(observed).toEqual([jsonPayload, jsonPayload, MULTIBYTE_TEXT])
    } finally {
      vm.dispose()
    }
  })

  it('binary request bodies (Uint8Array / ArrayBuffer) reach the host base64-tagged and byte-exact', async () => {
    const { env, recorder } = makeRecorderEnv({
      onCall: (target) =>
        target === 'network.fetch'
          ? { status: 200, ok: true, headers: {}, body: '', bodyEncoding: 'utf8' }
          : null,
    })
    const vm = await createPluginVm({
      env,
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = async function activate() {
            const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x7f]);
            await fetch('https://api.example.com/u8', { method: 'POST', body: bytes });
            await fetch('https://api.example.com/ab', { method: 'POST', body: bytes.buffer });
            // A view with a non-zero offset must serialize ONLY its window.
            const padded = new Uint8Array(bytes.length + 4);
            padded.set(bytes, 2);
            await fetch('https://api.example.com/view', { method: 'POST', body: new Uint8Array(padded.buffer, 2, bytes.length) });
          };
        })();
      `,
    })
    try {
      await vm.runLifecycle('activate')
      const inits = recorder
        .filter((e) => e.target === 'network.fetch')
        .map((e) => e.args[1] as { body?: string; bodyEncoding?: string })
      expect(inits).toHaveLength(3)
      for (const init of inits) {
        expect(init.bodyEncoding).toBe('base64')
        expect(base64ToBytes(init.body ?? '')).toEqual(PNG_BYTES)
      }
    } finally {
      vm.dispose()
    }
  })

  it('string request bodies stay utf8 text on the wire', async () => {
    const { env, recorder } = makeRecorderEnv({
      onCall: (target) =>
        target === 'network.fetch'
          ? { status: 200, ok: true, headers: {}, body: '', bodyEncoding: 'utf8' }
          : null,
    })
    const vm = await createPluginVm({
      env,
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = async function activate() {
            await fetch('https://api.example.com/t', { method: 'POST', body: ${JSON.stringify(MULTIBYTE_TEXT)} });
          };
        })();
      `,
    })
    try {
      await vm.runLifecycle('activate')
      const init = recorder.find((e) => e.target === 'network.fetch')?.args[1] as
        { body?: string; bodyEncoding?: string }
      expect(init.bodyEncoding).toBe('utf8')
      expect(init.body).toBe(MULTIBYTE_TEXT)
    } finally {
      vm.dispose()
    }
  })

  it('unsupported body types (FormData & co.) throw a TypeError naming the supported types', async () => {
    const { env, recorder } = makeRecorderEnv()
    const vm = await createPluginVm({
      env,
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = async function activate() {
            // The sandbox has no FormData global — model the same mistake with
            // an arbitrary object (exactly what a vendored FormData polyfill
            // would hand to fetch).
            function FormData() { this.append = function () {}; }
            let caught = null;
            try {
              await fetch('https://api.example.com/x', { method: 'POST', body: new FormData() });
            } catch (err) {
              caught = { name: err && err.name, message: err && err.message };
            }
            await __hostCall('test.record', [caught]);
          };
        })();
      `,
    })
    try {
      await vm.runLifecycle('activate')
      // The host-side network.fetch must never have been invoked.
      expect(recorder.filter((e) => e.target === 'network.fetch')).toHaveLength(0)
      const caught = recorder.find((e) => e.target === 'test.record')?.args[0] as
        { name: string; message: string }
      expect(caught.name).toBe('TypeError')
      expect(caught.message).toContain('string, ArrayBuffer, or TypedArray/DataView')
      expect(caught.message).toContain('FormData')
    } finally {
      vm.dispose()
    }
  })
})

describe('plugin sandbox: routes — binary bodies', () => {
  /** Boot a VM whose plugin registers POST /echo and exercises binary I/O. */
  async function makeRouteVm(handlerBody: string) {
    const { env, recorder } = makeRecorderEnv({
      grantedPermissions: ['cms.routes'],
      onCall: () => null, // cms.routes.register round-trip
    })
    const vm = await createPluginVm({
      env,
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = async function activate(api) {
            api.cms.routes.post('/echo', 'plugins.read', async function (ctx) {
              ${handlerBody}
            });
          };
        })();
      `,
    })
    await vm.runLifecycle('activate')
    return { vm, recorder }
  }

  it('req.arrayBuffer() returns the exact raw body bytes; binary __response leaves base64-tagged', async () => {
    const { vm, recorder } = await makeRouteVm(`
      const bytes = new Uint8Array(await ctx.req.arrayBuffer());
      await __hostCall('test.record', [Array.from(bytes)]);
      return { __response: true, status: 200, headers: { 'content-type': 'image/png' }, body: bytes };
    `)
    try {
      const result = await vm.runRoute('POST:/echo', {
        request: {
          url: 'http://localhost/admin/api/cms/plugins/acme.binary/runtime/echo',
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytesToBase64(PNG_BYTES),
          bodyEncoding: 'base64',
        },
        body: {},
        user: null,
      }) as { __response: boolean; status: number; body: string; bodyEncoding: string }

      const observed = recorder.find((e) => e.target === 'test.record')?.args[0]
      expect(observed).toEqual(Array.from(PNG_BYTES))
      expect(result.__response).toBe(true)
      expect(result.status).toBe(200)
      expect(result.bodyEncoding).toBe('base64')
      expect(base64ToBytes(result.body)).toEqual(PNG_BYTES)
    } finally {
      vm.dispose()
    }
  })

  it('req.text()/req.json() decode a base64-tagged UTF-8 body (multibyte intact)', async () => {
    const payload = JSON.stringify({ note: MULTIBYTE_TEXT })
    const { vm, recorder } = await makeRouteVm(`
      const text = await ctx.req.text();
      const parsed = await ctx.req.json();
      await __hostCall('test.record', [text, parsed.note]);
    `)
    try {
      await vm.runRoute('POST:/echo', {
        request: {
          url: 'http://localhost/x',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: bytesToBase64(new TextEncoder().encode(payload)),
          bodyEncoding: 'base64',
        },
        body: {},
        user: null,
      })
      const observed = recorder.find((e) => e.target === 'test.record')?.args
      expect(observed).toEqual([payload, MULTIBYTE_TEXT])
    } finally {
      vm.dispose()
    }
  })

  it('multipart file markers materialize into file facades with byte-exact arrayBuffer()', async () => {
    const { vm, recorder } = await makeRouteVm(`
      const file = ctx.body.file;
      const bytes = new Uint8Array(await file.arrayBuffer());
      await __hostCall('test.record', [file.name, file.type, file.size, Array.from(bytes), ctx.body.label]);
      return { __response: true, status: 201, headers: { 'content-type': file.type }, body: bytes.buffer };
    `)
    try {
      const result = await vm.runRoute('POST:/echo', {
        request: {
          url: 'http://localhost/x',
          method: 'POST',
          headers: { 'content-type': 'multipart/form-data; boundary=x' },
          body: bytesToBase64(PNG_BYTES),
          bodyEncoding: 'base64',
        },
        body: {
          file: {
            __file: true,
            name: 'pixel.png',
            type: 'image/png',
            size: PNG_BYTES.byteLength,
            dataBase64: bytesToBase64(PNG_BYTES),
          },
          label: 'tiny png',
        },
        user: null,
      }) as { status: number; body: string; bodyEncoding: string }

      const observed = recorder.find((e) => e.target === 'test.record')?.args
      expect(observed).toEqual(['pixel.png', 'image/png', PNG_BYTES.byteLength, Array.from(PNG_BYTES), 'tiny png'])
      expect(result.status).toBe(201)
      expect(result.bodyEncoding).toBe('base64')
      expect(base64ToBytes(result.body)).toEqual(PNG_BYTES)
    } finally {
      vm.dispose()
    }
  })

  it('string __response bodies stay utf8; plain-object returns stay JSON', async () => {
    const { vm } = await makeRouteVm(`
      const mode = (await ctx.req.json()).mode;
      if (mode === 'raw') {
        return { __response: true, status: 200, headers: { 'content-type': 'text/plain' }, body: ${JSON.stringify(MULTIBYTE_TEXT)} };
      }
      return { ok: true, mode: mode };
    `)
    const post = (mode: string) => vm.runRoute('POST:/echo', {
      request: {
        url: 'http://localhost/x',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
        bodyEncoding: 'utf8',
      },
      body: { mode },
      user: null,
    })
    try {
      const raw = await post('raw') as { body: string; bodyEncoding: string }
      expect(raw.bodyEncoding).toBe('utf8')
      expect(raw.body).toBe(MULTIBYTE_TEXT)
      expect(await post('json')).toEqual({ ok: true, mode: 'json' })
    } finally {
      vm.dispose()
    }
  })
})
