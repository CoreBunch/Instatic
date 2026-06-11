/**
 * Regression tests for the QuickJS module-pack source shim.
 *
 * The shim converts the ESM-shaped bundle Bun emits into a
 * `globalThis.__module_pack = …` assignment that the bootstrap can read
 * inside QuickJS. Both export forms below have been seen in real plugin
 * bundles (module-pack plugins such as `acme.forms`) and must work.
 */
import { describe, expect, it } from 'bun:test'
import { createModulePackVm } from '../../../server/plugins/modulePackVm'
import {
  DEFAULT_EVAL_TIMEOUT_MS,
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_STACK_SIZE_BYTES,
  MODULE_PACK_EVAL_TIMEOUT_MS,
} from '../../../server/plugins/quickjs/limits'

const PACK_BODY = `
function defineModule(def) { return def; }
const counter = defineModule({
  id: 'acme.canvas.counter',
  name: 'Counter',
  category: 'Acme',
  version: '1.0.0',
  defaults: { count: 0 },
  schema: {},
  render: (props) => ({ html: '<div>' + String(props.count) + '</div>' }),
});
var __modules_facade_default = [counter];
`

describe('modulePackVm — source shim', () => {
  it('accepts `export default <expr>` bundles', async () => {
    const source = `${PACK_BODY}\nexport default __modules_facade_default;\n`
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: source })
    try {
      expect(vm.modules.map((m) => m.id)).toEqual(['acme.canvas.counter'])
    } finally {
      vm.dispose()
    }
  })

  it('accepts `export { X as default }` bundles (single-line)', async () => {
    const source = `${PACK_BODY}\nexport { __modules_facade_default as default };\n`
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: source })
    try {
      expect(vm.modules.map((m) => m.id)).toEqual(['acme.canvas.counter'])
    } finally {
      vm.dispose()
    }
  })

  it('accepts `export { X as default }` bundles (multi-line block)', async () => {
    // The exact shape Bun's bundler produces for a re-export facade.
    const source = `${PACK_BODY}\nexport {\n  __modules_facade_default as default\n};\n`
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: source })
    try {
      expect(vm.modules.map((m) => m.id)).toEqual(['acme.canvas.counter'])
    } finally {
      vm.dispose()
    }
  })

  it('loads packs with an export-function sibling alongside the default (previously-divergent form)', async () => {
    // The old module-pack shim only rewrote the two `default` forms, so an
    // `export function` sibling stayed a bare `export` and the bundle threw a
    // SyntaxError — even though it loads fine as a plugin. The shared shim
    // rewrites the sibling out of the way and still resolves the default.
    const source = `${PACK_BODY}\nexport function unusedHelper() { return 1; }\nexport default __modules_facade_default;\n`
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: source })
    try {
      expect(vm.modules.map((m) => m.id)).toEqual(['acme.canvas.counter'])
    } finally {
      vm.dispose()
    }
  })
})

describe('modulePackVm — shared sandbox limits', () => {
  it('uses the same memory/stack ceilings as full-plugin VMs (no fork, no weakening)', () => {
    // Both VMs import these from quickjs/limits.ts. The security guarantee is
    // that there is ONE source — a hardening change to one VM cannot silently
    // skip the other. These exact values are the pre-unification module-pack
    // limits (64 MB / 1 MB), preserved.
    expect(DEFAULT_MEMORY_LIMIT_BYTES).toBe(64 * 1024 * 1024)
    expect(DEFAULT_STACK_SIZE_BYTES).toBe(1 * 1024 * 1024)
  })

  it('keeps the module-pack eval deadline at its own value (2 s, distinct from the 5 s plugin budget)', () => {
    expect(MODULE_PACK_EVAL_TIMEOUT_MS).toBe(2_000)
    expect(DEFAULT_EVAL_TIMEOUT_MS).toBe(5_000)
    expect(MODULE_PACK_EVAL_TIMEOUT_MS).toBeLessThan(DEFAULT_EVAL_TIMEOUT_MS)
  })

  it('enforces the stack ceiling — runaway recursion in render() throws, not hangs', async () => {
    const source = `
      function defineModule(def) { return def; }
      const recurse = defineModule({
        id: 'acme.canvas.recurse',
        name: 'Recurse',
        category: 'Acme',
        version: '1.0.0',
        defaults: {},
        schema: {},
        render: () => { function r() { return 1 + r(); } return { html: String(r()) }; },
      });
      export default [recurse];
    `
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: source })
    try {
      expect(() => vm.render('acme.canvas.recurse', {}, [])).toThrow()
    } finally {
      vm.dispose()
    }
  })

  it('enforces the wall-clock deadline — an infinite loop in render() is interrupted', async () => {
    const source = `
      function defineModule(def) { return def; }
      const spin = defineModule({
        id: 'acme.canvas.spin',
        name: 'Spin',
        category: 'Acme',
        version: '1.0.0',
        defaults: {},
        schema: {},
        render: () => { while (true) {} return { html: '' }; },
      });
      export default [spin];
    `
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: source })
    try {
      // If the deadline weren't wired through, this would hang the test
      // runner forever rather than throw an "interrupted" error.
      expect(() => vm.render('acme.canvas.spin', {}, [])).toThrow()
    } finally {
      vm.dispose()
    }
  }, 10_000)
})

describe('modulePackVm — render js boundary', () => {
  const JS_PACK = `
const widget = {
  id: 'acme.canvas.widget',
  name: 'Widget',
  category: 'Acme',
  version: '1.0.0',
  defaults: {},
  schema: {},
  render: () => ({ html: '<div></div>', js: '(function(){})();' }),
};
const badJs = {
  id: 'acme.canvas.badjs',
  name: 'BadJs',
  category: 'Acme',
  version: '1.0.0',
  defaults: {},
  schema: {},
  render: () => ({ html: '<div></div>', js: 42 }),
};
export default [widget, badJs];
`

  it('passes string render() js through the VM boundary', async () => {
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: JS_PACK })
    try {
      const out = vm.render('acme.canvas.widget', {}, [])
      expect(out.html).toBe('<div></div>')
      expect(out.js).toBe('(function(){})();')
    } finally {
      vm.dispose()
    }
  })

  it('drops non-string js at the VM boundary', async () => {
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: JS_PACK })
    try {
      expect(vm.render('acme.canvas.badjs', {}, []).js).toBeUndefined()
    } finally {
      vm.dispose()
    }
  })
})
