/**
 * Architecture gates for the plugin sandbox.
 *
 * The QuickJS-WASM sandbox is the load-bearing security boundary for
 * plugin code. These tests lock in the invariants that make it real:
 * if any of them fail, the sandbox's guarantees no longer hold.
 *
 * Per CLAUDE.md: "Architectural rules are first-class. When you change a
 * structural rule (folder layout, allowed imports, banned APIs, design
 * tokens), update the matching test in src/__tests__/architecture/."
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

/**
 * Best-effort stripper of `//` line comments, `/* ... *\/` block comments,
 * and string literals. Used by architecture tests that need to scan ACTUAL
 * code for forbidden patterns — strings in docstrings shouldn't count.
 *
 * Not a full parser; nested string/comment edge cases (regex literals
 * containing `//`, template literals with `${}` interpolating code) are
 * handled imperfectly. Good enough for grep-style structural checks.
 */
function stripCommentsAndStrings(source: string): string {
  // Block comments
  let s = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  // Line comments
  s = s.replace(/\/\/[^\n]*/g, ' ')
  // String literals (single, double, backtick)
  s = s.replace(/'(?:\\.|[^'\\])*'/g, "''")
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""')
  s = s.replace(/`(?:\\.|[^`\\])*`/g, '``')
  return s
}

describe('plugin sandbox invariants', () => {
  it('pluginWorker.ts imports the QuickJS bridge (no fallback to dynamic import)', async () => {
    const source = await read('server/plugins/pluginWorker.ts')
    expect(source).toContain("from './quickjs/vm'")
    expect(source).toContain('createPluginVm')
    // No dynamic import of arbitrary plugin code in the worker — that was
    // the pre-sandbox RCE pathway. `await import(`...) inside the worker
    // is only ever used for plugin code, so any occurrence here is a bug.
    expect(source).not.toMatch(/await\s+import\s*\(/)
  })

  it('quickjs/vm.ts uses sync QuickJS + ctx.newPromise (no asyncified host functions)', async () => {
    const source = await read('server/plugins/quickjs/vm.ts')
    // Sync variant — asyncified is known to corrupt VM state on the second
    // async eval (see comment block at the top of vm.ts). The WASM binary is
    // file-embedded and handed to the sync variant explicitly so compiled
    // single-file server binaries can load it (see release artifacts).
    expect(source).toContain('RELEASE_SYNC')
    expect(source).toContain('newVariant(RELEASE_SYNC')
    expect(source).not.toContain('RELEASE_ASYNC')
    expect(source).not.toContain('newQuickJSAsyncWASMModule')
    expect(source).not.toContain('newAsyncifiedFunction')
    // Deferred VM-side Promise pattern is what we rely on.
    expect(source).toContain('ctx.newPromise()')
  })

  it('modulePackVm.ts sandboxes module packs through QuickJS', async () => {
    const source = await read('server/plugins/modulePackVm.ts')
    // Sandboxing now rides the SHARED QuickJS infrastructure (one WASM
    // singleton + one deadline guard + one ESM shim) rather than a private
    // copy: getWasmModule/createContext from ./quickjs/vm, the deadline-guarded
    // eval from ./quickjs/eval. We assert the actual sandbox PROPERTIES are
    // enforced here, which is stronger than matching the raw import specifier.
    expect(source).toContain("from './quickjs/vm'") // shared QuickJS WASM singleton
    expect(source).toContain('newContext')
    expect(source).toContain('setMemoryLimit') // heap ceiling enforced
    expect(source).toContain('setMaxStackSize') // stack ceiling enforced
    expect(source).toContain('withSyncDeadline') // wall-clock interrupt guard
    // No raw dynamic import of plugin bundles in actual code lines.
    // (Comments may mention historical context — strip them before scanning.)
    const codeOnly = stripCommentsAndStrings(source)
    expect(codeOnly).not.toMatch(/await\s+import\s*\(.*dataUrl/)
  })

  it('server/plugins/runtime.ts loads module packs into a sandboxed VM, not a raw dynamic import', async () => {
    const source = await read('server/plugins/runtime.ts')
    expect(source).toContain('createModulePackVm')
    // The old `await import(dataUrl)` plugin loader path is the exact
    // pattern that bypassed the sandbox. It must not return as live code.
    const codeOnly = stripCommentsAndStrings(source)
    expect(codeOnly).not.toMatch(/await\s+import\s*\(\s*dataUrl/)
    expect(codeOnly).not.toMatch(/\bimport\s*\(\s*dataUrl/)
  })

  it('server entrypoint and module pack bundles are scanned at install time', async () => {
    const source = await read('server/plugins/package.ts')
    expect(source).toContain('assertSandboxSafe')
    // Both server entrypoint AND module pack are sandboxed; both must be
    // scanned. The check below catches a future regression where one is
    // forgotten when adding more sandboxed entrypoints.
    const scanCount = (source.match(/assertSandboxSafe/g) ?? []).length
    expect(scanCount).toBeGreaterThanOrEqual(2)
  })

  it('the SDK build pipeline applies the same sandbox scan at build time', async () => {
    const source = await read('src/core/plugin-sdk/cli/build.ts')
    expect(source).toContain('assertSandboxSafe')
    // Sandboxed bundles must be emitted as IIFE (the format QuickJS can
    // eval). The build pipeline used to ship ESM with `export function …`
    // and rely on a runtime regex shim; the IIFE path makes the contract
    // explicit and removes the regex.
    expect(source).toContain("format: options.sandbox ? 'iife' : 'esm'")
  })

  it('the network.outbound permission is fail-closed without an allowlist', async () => {
    // host/network.ts owns the allowlist check; host/apiDispatch.ts owns the
    // dispatch table entry AND (since the permission model was centralized)
    // the permission gate, driven by protocol/targets.ts:TARGET_PERMISSIONS.
    const networkSource = await read('server/plugins/host/network.ts')
    const dispatchSource = await read('server/plugins/host/apiDispatch.ts')
    const targetsSource = await read('server/plugins/protocol/targets.ts')
    expect(networkSource).toContain('hostMatchesAllowlist')
    expect(networkSource).toContain('networkAllowedHosts')
    // The dispatch table entry must be present in apiDispatch.ts.
    expect(dispatchSource).toContain("'network.fetch':")
    // The permission gate is now CENTRAL: apiDispatch looks up the required
    // permission and asserts it before any handler runs. Missing either the
    // central assert call or the network.fetch→network.outbound pairing would
    // be a security bug.
    expect(dispatchSource).toContain('assertHostPluginPermission(entry, requiredPermission)')
    expect(targetsSource).toContain("'network.fetch': 'network.outbound'")
  })

  it('BOOTSTRAP_SOURCE provides URL, URLSearchParams, TextEncoder, TextDecoder globals', async () => {
    // These Web APIs are absent from QuickJS; the bootstrap polyfills them so
    // plugin code can use `new URL(req.url)`, `new TextEncoder().encode(s)`,
    // etc. without bundling its own implementations.
    // We check for the globalThis assignments rather than the implementation
    // details so the test stays stable across polyfill rewrites.
    const source = await read('server/plugins/quickjs/bootstrap/polyfills.ts')
    expect(source).toContain('globalThis.URL = ')
    expect(source).toContain('globalThis.URLSearchParams = ')
    expect(source).toContain('globalThis.TextEncoder = ')
    expect(source).toContain('globalThis.TextDecoder = ')
    // The forbidden-literal scan must still pass: no node: / bun: / require(
    // / process.binding inside BOOTSTRAP_SOURCE.
    expect(source).not.toMatch(/globalThis\.(URL|TextEncoder|TextDecoder)\s*=.*require\s*\(/)
  })

  it('worker protocol allows only the documented api-call targets', async () => {
    // `ApiCallSchemas` (in apiCallSchema.ts) is the SINGLE SOURCE of the
    // accepted dotted RPC names — `ALLOWED_API_TARGETS` / `isAllowedApiTarget`
    // / `ValidatedApiCall` are all derived from its keys. Anything not in this
    // record is rejected before any side effect. Locking the key set down
    // prevents accidental surface expansion.
    //
    // The keys are extracted from the source record (each line is
    // `'<target>': apiCallSchema('<target>', …)`) so the gate stays stable
    // without evaluating the module.
    const source = await read('server/plugins/protocol/apiCallSchema.ts')
    const recordMatch = source.match(
      /export const ApiCallSchemas = \{([\s\S]*?)\n\} satisfies Record/,
    )
    expect(recordMatch).not.toBeNull()
    const recordBody = recordMatch![1]
    const literals = (recordBody.match(/^\s*'([a-z][a-zA-Z.]+)':/gm) ?? [])
      .map((s) => s.trim().replace(/':$/, '').replace(/^'/, ''))
      .sort()
    expect(literals).toEqual([
      'cms.content.entries.create',
      'cms.content.entries.createMany',
      'cms.content.entries.delete',
      'cms.content.entries.deleteMany',
      'cms.content.entries.get',
      'cms.content.entries.getBySlug',
      'cms.content.entries.list',
      'cms.content.entries.moveTable',
      'cms.content.entries.publish',
      'cms.content.entries.update',
      'cms.content.entries.updateMany',
      'cms.content.republishAll',
      'cms.content.search',
      'cms.content.snapshot',
      'cms.content.tables.create',
      'cms.content.tables.get',
      'cms.content.tables.list',
      'cms.content.tree.mutate',
      'cms.content.tree.read',
      'cms.content.tree.replace',
      'cms.hooks.emit',
      'cms.hooks.filter',
      'cms.hooks.on',
      'cms.loops.registerSource',
      'cms.media.registerStorageAdapter',
      'cms.media.registerUrlTransformer',
      'cms.media.registerVariantDelegate',
      'cms.routes.register',
      'cms.schedule.cancel',
      'cms.schedule.register',
      'cms.settings.replace',
      'cms.storage.create',
      'cms.storage.delete',
      'cms.storage.list',
      'cms.storage.update',
      'crypto.digest',
      'crypto.signHmac',
      'network.abort',
      'network.fetch',
    ])
  })
})
