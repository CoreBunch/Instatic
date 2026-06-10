/**
 * Locks the behavior of the ONE ESM→global shim shared by both QuickJS
 * sandboxes (`server/plugins/quickjs/esmShim.ts`).
 *
 * Before unification the full-plugin worker and the module-pack VM each kept a
 * private copy that DIVERGED: the worker handled `export function/const/let`
 * and named re-export blocks, the module-pack copy handled only the two
 * `default` forms. A bundle using a worker-only form therefore loaded as a
 * plugin but silently failed to load as a module pack. These tests assert the
 * unified shim handles every export form for BOTH global names so the two can
 * never drift again.
 *
 * Each case runs the produced IIFE against an isolated `globalThis` stand-in
 * (a plain object passed as the `globalThis` parameter, shadowing the real
 * global) and inspects what the shim attached.
 */
import { describe, expect, it } from 'bun:test'
import { wrapEsmAsGlobal } from '../../../server/plugins/quickjs/esmShim'

type Sandbox = Record<string, unknown>

function run(source: string): Sandbox {
  const sandbox: Sandbox = {}
  // The wrapped IIFE references `globalThis` — passing our own as the
  // parameter shadows the real global so nothing leaks between cases.
  new Function('globalThis', source)(sandbox)
  return sandbox
}

describe('wrapEsmAsGlobal — object mode (__plugin_exports)', () => {
  const wrap = (src: string) => wrapEsmAsGlobal(src, '__plugin_exports')

  it('collects export default <expr>', () => {
    const out = run(wrap(`export default { name: 'def' };`))
    expect((out.__plugin_exports as Sandbox).default).toEqual({ name: 'def' })
  })

  it('collects export { x as default }', () => {
    const out = run(wrap(`const x = [1, 2];\nexport { x as default };`))
    expect((out.__plugin_exports as Sandbox).default).toEqual([1, 2])
  })

  it('collects export function / const / let as named properties', () => {
    const out = run(wrap(
      `export function activate() { return 'a'; }\n` +
      `export const fromConst = 'c';\n` +
      `export let fromLet = 'l';`,
    ))
    const exports = out.__plugin_exports as Sandbox
    expect(typeof exports.activate).toBe('function')
    expect((exports.activate as () => string)()).toBe('a')
    expect(exports.fromConst).toBe('c')
    expect(exports.fromLet).toBe('l')
  })

  it('collects named re-export blocks', () => {
    const out = run(wrap(`const a = 1;\nconst b = 2;\nexport { a, b };`))
    const exports = out.__plugin_exports as Sandbox
    expect(exports.a).toBe(1)
    expect(exports.b).toBe(2)
  })

  it('collects mixed default + named export blocks', () => {
    const out = run(wrap(`const main = 'm';\nconst extra = 'e';\nexport { main as default, extra };`))
    const exports = out.__plugin_exports as Sandbox
    expect(exports.default).toBe('m')
    expect(exports.extra).toBe('e')
  })
})

describe('wrapEsmAsGlobal — unwrapDefault mode (__module_pack)', () => {
  const wrap = (src: string) => wrapEsmAsGlobal(src, '__module_pack', { unwrapDefault: true })

  it('assigns the default value directly for export default <expr>', () => {
    const out = run(wrap(`export default [{ id: 'a' }];`))
    expect(out.__module_pack).toEqual([{ id: 'a' }])
  })

  it('assigns the default value for export { x as default }', () => {
    const out = run(wrap(`const mods = [{ id: 'b' }];\nexport { mods as default };`))
    expect(out.__module_pack).toEqual([{ id: 'b' }])
  })

  it('assigns a default-exported function directly', () => {
    const out = run(wrap(`export default function () { return [{ id: 'fn' }]; }`))
    expect(typeof out.__module_pack).toBe('function')
    expect((out.__module_pack as () => unknown)()).toEqual([{ id: 'fn' }])
  })

  it('tolerates export-function siblings alongside the default — the previously-divergent form', () => {
    // This is the bug the unification fixes: the old module-pack copy only
    // rewrote the two `default` forms, so an `export function` sibling stayed
    // as a bare `export` and the whole bundle threw a SyntaxError as a module
    // pack (it loaded fine as a plugin). The unified shim rewrites the sibling
    // out of the way and still resolves the default value.
    const out = run(wrap(
      `const mods = [{ id: 'c' }];\n` +
      `export function helper() { return 1; }\n` +
      `export { mods as default };`,
    ))
    expect(out.__module_pack).toEqual([{ id: 'c' }])
  })
})

describe('wrapEsmAsGlobal — pass-through', () => {
  it('returns source untouched when it already targets the global', () => {
    const pre = `globalThis.__plugin_exports = { activate() {} };`
    expect(wrapEsmAsGlobal(pre, '__plugin_exports')).toBe(pre)
  })

  it('pass-through is per-global-name (module pack)', () => {
    const pre = `globalThis.__module_pack = [];`
    expect(wrapEsmAsGlobal(pre, '__module_pack', { unwrapDefault: true })).toBe(pre)
  })
})

describe('wrapEsmAsGlobal — stack-trace line numbers', () => {
  it('adds zero line offset so VM stack frames match the shipped bundle', () => {
    // The IIFE prelude shares the first physical line with the source's
    // first line; a wrapper that prepended its own lines would shift every
    // QuickJS stack-trace line number reported under `plugin:<id>`.
    const src = `const a = 1;\nconst b = 2;\nexport default a + b;`
    const lines = wrapEsmAsGlobal(src, '__plugin_exports').split('\n')
    expect(lines[0]).toContain('const a = 1;')
    expect(lines[1]).toBe('const b = 2;')
    expect(lines[2]).toContain('__exports.default = a + b;')
  })

  it('still evaluates correctly with the single-line prelude', () => {
    const out = run(wrapEsmAsGlobal(`// leading comment\nexport const x = 41 + 1;`, '__plugin_exports'))
    expect((out.__plugin_exports as Sandbox).x).toBe(42)
  })
})
