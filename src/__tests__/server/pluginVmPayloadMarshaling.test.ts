/**
 * Host→VM payload marshaling fidelity.
 *
 * Every `vm.run*` dispatch crosses the boundary through persistent function
 * handles (`ctx.callFunction` + `ctx.newString` — see `callResolved` in
 * `server/plugins/quickjs/eval.ts`), NOT by splicing the payload into a JS
 * source string. These tests pin the contract that matters for that path:
 * any JSON-serializable payload — including strings full of quotes,
 * backslashes, template-literal syntax, source-breaking separators, and
 * lone surrogates — round-trips byte-identically through the VM.
 */

import { describe, expect, it, afterAll } from 'bun:test'
import { createPluginVm, type PluginVm } from '../../../server/plugins/quickjs/vm'

/**
 * Plugin that registers an identity hook filter and an echo route straight
 * into the bootstrap registries (the registries exist before plugin source
 * evaluates, so direct injection is the smallest faithful setup).
 */
const ECHO_PLUGIN_SOURCE = `
  ;(function () {
    const __plugin_exports = (globalThis.__plugin_exports = {});
    __plugin_exports.activate = async function activate() { /* noop */ };
    globalThis.__plugin_handlers.filters['test.identity'] = function (value) { return value; };
    globalThis.__plugin_handlers.routes['GET /echo'] = async function (ctx) {
      return { echoedBody: await ctx.req.text(), echoedUrl: ctx.req.url };
    };
  })();
`

async function makeEchoVm(): Promise<PluginVm> {
  return createPluginVm({
    pluginSource: ECHO_PLUGIN_SOURCE,
    env: {
      pluginId: 'test.marshal',
      manifestVersion: '1.0.0',
      grantedPermissions: [],
      assetBasePath: '/uploads/plugins/test.marshal/1.0.0',
      settings: {},
      hostCall: async () => null,
      log: () => {},
    },
  })
}

const vmPromise = makeEchoVm()
afterAll(async () => {
  (await vmPromise).dispose()
})

/**
 * Strings chosen to break source-string splicing: each one would need
 * escaping (or is outright illegal) inside a JS source literal, so a
 * regression back to compile-the-payload dispatch fails loudly here.
 */
const TRICKY_STRINGS: Array<[label: string, value: string]> = [
  ['double quotes', 'He said "hello" and \'goodbye\''],
  ['backslashes', 'C:\\Users\\test\\\\double \\n not-a-newline \\u0041'],
  ['backticks + template syntax', 'price: `${1 + 1}` and ${injected}'],
  ['script-breaking html', '</script><script>alert(1)</script>'],
  ['real newlines and tabs', 'line one\nline two\r\n\ttabbed'],
  ['line/paragraph separators', 'before\u2028between\u2029after'],
  ['unicode (emoji, CJK, RTL)', '🎉 日本語 العربية ñ é ü'],
  ['null byte and control chars', 'a\u0000b\u0001c\u001fd'],
  ['lone high surrogate', 'broken \ud83d surrogate'],
  ['lone low surrogate', 'broken \ude00 surrogate'],
  ['surrogate pair split across content', '😀 then lone \ud83d end'],
]

describe('plugin VM payload marshaling', () => {
  it('round-trips tricky strings byte-identically through runHookFilter', async () => {
    const vm = await vmPromise
    for (const [label, value] of TRICKY_STRINGS) {
      const result = await vm.runHookFilter('test.identity', value)
      expect(result as string, label).toBe(value)
    }
  })

  it('round-trips a structured payload with tricky keys and values through runHookFilter', async () => {
    const vm = await vmPromise
    const payload = {
      'key "with" quotes': TRICKY_STRINGS.map(([, v]) => v),
      'key\\with\\backslashes': { nested: 'va`lue ${x}', n: 12.5, flag: true, nil: null },
      'sep\u2028key\u2029tail': ['</script>', '\ud83d'],
    }
    const result = await vm.runHookFilter('test.identity', payload)
    expect(result).toEqual(payload)
  })

  it('round-trips a large payload with every tricky string embedded', async () => {
    const vm = await vmPromise
    const unit = TRICKY_STRINGS.map(([, v]) => v).join(' | ')
    const value = unit.repeat(Math.ceil(200_000 / unit.length))
    const result = await vm.runHookFilter('test.identity', value)
    expect(result).toBe(value)
  })

  it('carries tricky route bodies through runRoute verbatim', async () => {
    const vm = await vmPromise
    const body = TRICKY_STRINGS.map(([, v]) => v).join('\n')
    const result = await vm.runRoute('GET /echo', {
      request: {
        url: 'https://example.test/echo?q="quoted"&t=`tick`',
        method: 'GET',
        headers: { 'content-type': 'text/plain' },
        body,
        bodyEncoding: 'utf8',
      },
      body: {},
      user: null,
    })
    expect(result).toEqual({
      echoedBody: body,
      echoedUrl: 'https://example.test/echo?q="quoted"&t=`tick`',
    })
  })

  it('dispatches through handles grabbed before plugin code runs — reassigning the global cannot hijack', async () => {
    const vm = await createPluginVm({
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = async function activate() { /* noop */ };
          globalThis.__plugin_handlers.filters['test.identity'] = function (value) { return value; };
          // A malicious bundle replacing the dispatcher global must not be
          // able to intercept host dispatch.
          globalThis.__runHookFilter = async function () { return '"hijacked"'; };
        })();
      `,
      env: {
        pluginId: 'test.hijack',
        manifestVersion: '1.0.0',
        grantedPermissions: [],
        assetBasePath: '/uploads/plugins/test.hijack/1.0.0',
        settings: {},
        hostCall: async () => null,
        log: () => {},
      },
    })
    try {
      const result = await vm.runHookFilter('test.identity', 'original')
      expect(result).toBe('original')
    } finally {
      vm.dispose()
    }
  })
})
