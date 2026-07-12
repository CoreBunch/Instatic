/**
 * Entrypoint bundling — the one `Bun.build` choke point every plugin build
 * surface goes through (CLI `instatic-plugin build|dev`, the server-side
 * site plugin build). Owns the externals layering, sandbox facades,
 * post-bundle sandbox scans, and the optional import-containment resolver.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertSandboxSafe } from '@core/plugins/sandboxScan'
import type { ImportResolverPolicy } from './buildPackage'
import { containmentPlugin } from './containment'
import { generateSandboxFacade } from './facades'

/**
 * Externals for plugin **admin/editor** bundles (admin pages, editor
 * entrypoints, canvas modules).
 *
 * Bun.build leaves these names as bare imports. At runtime, the host's
 * import map (`index.html`) resolves them to the host's React instance,
 * design-system primitives, plugin SDK helpers, and editor/settings
 * hooks — so plugins share host React + host UI without bundling a
 * copy. This is what gives plugin bundles ~kilobyte sizes and keeps
 * the editor's design-system contract stable across plugin upgrades.
 *
 * Two bundle modes that DO NOT externalize:
 *   - `sandbox` — server entrypoints load in the host's Bun worker;
 *     no browser host runtime there.
 *   - `frontendBundle: true` — frontend scripts run on PUBLISHED pages,
 *     which never load the editor's import map. A bare `import 'react'`
 *     in a frontend bundle would crash at runtime ("Failed to resolve
 *     module specifier"). Frontend scripts must either bundle React
 *     themselves or stick to `window.__instatic` and vanilla DOM.
 */
export const HOST_RUNTIME_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  '@instatic/host-ui',
  '@instatic/host-hooks',
  '@instatic/plugin-sdk',
]

export interface BundleOptions {
  /**
   * When set, the entrypoint will be wrapped in an IIFE that assigns the
   * plugin's exports to the given globalThis slot. Used for sandboxed code
   * — server entrypoints (`__plugin_exports`) and module packs
   * (`__module_pack`) — which run inside a QuickJS-WASM VM that cannot
   * resolve ES module syntax. The host's `pluginWorker.ts` /
   * `modulePackVm.ts` read from these globals.
   *
   * When this is set:
   *  - Externals are omitted (the bundle must be self-contained)
   *  - The bundled source is scanned for forbidden literals (`node:*`,
   *    `bun:*`, `require(`) and the build FAILS with a clear message if
   *    any are found — saves authors the round-trip of finding out at
   *    install time
   *  - For 'modules' kind, only the default export is exfiltrated; for
   *    'server' kind, the whole namespace becomes `__plugin_exports`
   */
  sandbox?: 'server' | 'modules'
  /**
   * When true, omit the host-runtime externals — use for `frontend.assets`
   * script bundles. Published pages don't have the host import map, so
   * frontend code can't rely on bare `react` / `@instatic/*` imports being
   * resolved. Bundle locally (or stick to `window.__instatic`).
   */
  frontendBundle?: boolean
  /**
   * When true, omit the host-runtime externals while keeping ESM format.
   * Use for `entrypoints.modules` (canvas module pack) bundles, which are
   * loaded by BOTH the browser editor (via dynamic import — has the host
   * import map) AND the server publisher / QuickJS sandbox (via
   * `modulePackVm` — NO import map, no module resolver).
   *
   * The browser path could resolve bare `@instatic/plugin-sdk` imports
   * via the import map, but the sandbox path cannot — and the SDK helpers
   * that module packs use (`defineModule`, `control`, `html`, `raw`,
   * `safeUrl`) are pure data builders with no React or host-state
   * dependency, so inlining them is the simple, correct fix.
   *
   * Without this flag, modules bundles would ship bare
   * `import { defineModule } from "@instatic/plugin-sdk"`, which fails
   * at module-pack-activate time inside the sandbox, the registry never
   * gets populated, and the publisher emits `<!-- instatic: unknown module -->`
   * comments on published pages.
   */
  inlineHostRuntime?: boolean
  /**
   * Extra bare specifiers to externalize on top of the host-runtime defaults.
   * Used for frontend bundles that lean on the published-page runtime
   * importmap — e.g. a Three.js plugin imports `three` and
   * `three/examples/jsm/...`, and both must stay as bare imports so the
   * browser's importmap resolves them to the host's locally-installed copy.
   * Subpath imports are matched via `<name>/*` glob so the addon files
   * (`three/examples/jsm/controls/OrbitControls.js`) also survive bundling.
   */
  externalSpecifiers?: string[]
  /**
   * Fail-closed import containment (site plugin builds). When set, every
   * import originating inside `resolve.workspaceRoot` must resolve inside
   * it; bare specifiers must be mapped or external. When absent, behavior
   * is byte-identical to the historical CLI build.
   */
  resolve?: ImportResolverPolicy
}

export async function bundleEntrypoint(
  sourcePath: string,
  outFile: string,
  options: BundleOptions = {},
): Promise<void> {
  // Externals layering, from most → least restrictive:
  //  - Sandboxed bundles (server / modules) get NO externals: they run in a
  //    QuickJS VM with no module resolver, so every dep must be inlined.
  //  - Frontend bundles default to NO externals (published pages have no
  //    import map of their own), but the caller can opt into runtime-resolved
  //    externals via `externalSpecifiers` — used when the host is going to
  //    emit an `<script type="importmap">` for the page's locked deps.
  //  - Admin / editor bundles share the host's React + design system via
  //    `HOST_RUNTIME_EXTERNALS` resolved by the editor's import map.
  const externalSet = new Set<string>()
  if (!options.sandbox) {
    if (!options.frontendBundle && !options.inlineHostRuntime) {
      for (const name of HOST_RUNTIME_EXTERNALS) externalSet.add(name)
    }
    for (const specifier of options.externalSpecifiers ?? []) {
      externalSet.add(specifier)
      // Bun.build (and esbuild) treat `name/*` as a glob — required to
      // externalize subpath imports like `three/examples/jsm/...` while
      // letting the bare `three` resolve via the same external.
      externalSet.add(`${specifier}/*`)
    }
  }
  const external = [...externalSet]

  // Sandboxed bundles go through a generated facade so the bundler can
  // resolve the user's entrypoint normally and we just hand-write the
  // global-slot assignment. The facade lives next to the entrypoint
  // briefly and is removed after the build.
  let entryToBundle = sourcePath
  let facadeCleanup: string | null = null
  if (options.sandbox) {
    const facade = generateSandboxFacade(resolve(sourcePath), options.sandbox)
    const facadePath = join(dirname(sourcePath), `__sandbox-facade-${Date.now()}.ts`)
    await writeFile(facadePath, facade, 'utf-8')
    entryToBundle = facadePath
    facadeCleanup = facadePath
  }

  try {
    // Bun surfaces plugin onResolve/onLoad throws as an AggregateError with
    // the generic message "Bundle failed" — unwrap the sub-errors so a
    // containment violation reads as itself, not as noise.
    const result = await Bun.build({
      entrypoints: [entryToBundle],
      target: 'browser',
      format: options.sandbox ? 'iife' : 'esm',
      splitting: false,
      minify: false,
      external,
      ...(options.resolve
        ? {
            plugins: [
              containmentPlugin({
                ...options.resolve,
                // The bundle's own externals stay bare imports — the runtime
                // import map resolves them; containment must not reject them.
                allowedExternals: options.resolve.allowedExternals ?? [...externalSet],
              }),
            ],
          }
        : {}),
      // Force production JSX. Without this, Bun's transpiler emits
      // `import { jsxDEV } from "react/jsx-dev-runtime"` for every JSX
      // expression — and that's fatal in a production host because React
      // 19's `react-jsx-dev-runtime.production.js` intentionally exports
      // `jsxDEV` as `void 0`. Plugin bundles then crash with
      // "TypeError: jsxDEV is not a function" as soon as any of their
      // components render. The runtime shim at
      // `public/runtime/react-jsx-dev-runtime.js` falls back to
      // `jsx`/`jsxs` defensively (for third-party plugins not built with
      // this CLI), but bundles built here should import the production
      // runtime directly. Bun's transpiler keys this off
      // `process.env.NODE_ENV`, so inlining it as a define is enough —
      // the `jsx` build-config field exists in the type defs but is not
      // honored by the transpiler in Bun 1.3.
      define: { 'process.env.NODE_ENV': '"production"' },
    }).catch((err: unknown) => {
      if (err instanceof AggregateError && err.errors.length > 0) {
        const messages = err.errors
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .join('\n')
        throw new Error(`Failed to bundle ${sourcePath}:\n${messages}`, { cause: err })
      }
      throw err
    })
    if (!result.success) {
      const messages = result.logs.map((l) => l.message).join('\n')
      throw new Error(`Failed to bundle ${sourcePath}:\n${messages}`)
    }
    const built = result.outputs[0]
    if (!built) throw new Error(`No output from Bun.build for ${sourcePath}`)
    const text = await built.text()

    if (options.sandbox) {
      // Defense in depth — fail the build NOW if the bundled output (after
      // tree-shaking and external resolution) still references Node/Bun
      // primitives. Plugin authors get a clear error instead of a
      // sandbox-time activation failure.
      assertSandboxSafe(text, sourcePath)
    }

    await mkdir(dirname(outFile), { recursive: true })
    await writeFile(outFile, text, 'utf-8')
  } finally {
    if (facadeCleanup) await rm(facadeCleanup, { force: true })
  }
}
