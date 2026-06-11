/**
 * Plugin build pipeline.
 *
 * Reads `<dir>/instatic-plugin.config.ts`, evaluates it via `import()` (Bun
 * transpiles TypeScript natively), and writes the runtime zip layout that
 * the host package installer expects:
 *
 *   <dir>/dist/
 *     plugin.json
 *     modules/index.js
 *     pack/site.json
 *     server/index.js              (when source has server/index.{ts,js})
 *     editor/index.js              (when source has editor/index.{ts,js})
 *     frontend/tracker.js          (when source has frontend/tracker.{ts,js})
 *     admin/<entry>.js             (per declared admin app entry)
 *
 * Then zips `dist/` into `<dir-parent>/<plugin-dir-name>.plugin.zip`.
 *
 * Bundling: each entrypoint is bundled with `Bun.build()` as ESM. Plugin
 * authors get one self-contained bundle per entrypoint with no
 * node_modules in the zip.
 */
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import type { PluginDefinition } from '../builders/definePlugin'
import { assertSandboxSafe } from '@core/plugins/sandboxScan'
import { installPackCompileEnvironment } from './packCompileEnvironment'

export interface PluginBuildResult {
  pluginId: string
  outputDir: string
  zipPath: string
}

export async function readPluginDefinition(sourceDir: string): Promise<PluginDefinition> {
  // The config may call definePack({ layouts }) which compiles HTML — give it
  // a DOM + the base module registry before it is evaluated.
  installPackCompileEnvironment()
  const configPath = join(sourceDir, 'instatic-plugin.config.ts')
  if (!existsSync(configPath)) {
    throw new Error(`instatic-plugin.config.ts not found at ${configPath}`)
  }
  const mod = await import(pathToFileURL(configPath).href + `?ts=${Date.now()}`) as { default: PluginDefinition }
  if (!mod.default || typeof mod.default !== 'object') {
    throw new Error(`instatic-plugin.config.ts must default-export a definePlugin() result`)
  }
  return mod.default
}

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
 *   - `serverSide: true` — server entrypoints load in the host's Bun
 *     worker; no browser host runtime there.
 *   - `frontendBundle: true` — frontend scripts run on PUBLISHED pages,
 *     which never load the editor's import map. A bare `import 'react'`
 *     in a frontend bundle would crash at runtime ("Failed to resolve
 *     module specifier"). Frontend scripts must either bundle React
 *     themselves or stick to `window.__instatic` and vanilla DOM.
 */
const HOST_RUNTIME_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  '@instatic/host-ui',
  '@instatic/host-hooks',
  '@instatic/plugin-sdk',
]

interface BundleOptions {
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
}

/**
 * Generate the IIFE facade source that re-exports the user's entrypoint to
 * a `globalThis.<slot>` so the QuickJS sandbox can find it. The user's
 * source is left untouched; this facade is bundled WITH it.
 *
 * For 'server' sandboxes the runner expects `__plugin_exports.activate`
 * etc. as direct properties — but plugin authors reasonably write either:
 *
 *   // shape A: named exports
 *   export function activate(api) { … }
 *   export function deactivate(api) { … }
 *
 *   // shape B: single default export — much more common in TS+ESM code
 *   const mod = { install, activate, deactivate, uninstall }
 *   export default mod
 *
 * Shape A maps cleanly to `import * as __plugin` (every named export shows
 * up as a property). Shape B does NOT — `__plugin.default` holds the
 * module object, and `__plugin.activate` is undefined, so the runner
 * silently no-ops the lifecycle hook. That's exactly the symptom we hit
 * with the uptime-monitor demo: install reported success but no schedules
 * landed because activate was never invoked.
 *
 * The facade therefore detects shape B at runtime and unwraps it. If the
 * default export looks like a plugin module (at least one of the known
 * lifecycle hooks is a function on it), we promote the default — falling
 * back to the namespace so shape A still works unchanged.
 *
 * For 'modules' sandboxes, only the default export is exfiltrated (the
 * SDK's `definePack` builder default-exports the array of modules).
 */
function generateSandboxFacade(entrypointAbsolutePath: string, kind: 'server' | 'modules'): string {
  // Bun's bundler accepts absolute paths in import specifiers.
  const importPath = JSON.stringify(entrypointAbsolutePath)
  if (kind === 'server') {
    return [
      `import * as __plugin from ${importPath};`,
      `const __default = __plugin && __plugin.default;`,
      `const __isPluginModule = (v) => v && typeof v === 'object' && (`,
      `  typeof v.install === 'function' || typeof v.activate === 'function' ||`,
      `  typeof v.deactivate === 'function' || typeof v.uninstall === 'function' ||`,
      `  typeof v.migrate === 'function'`,
      `);`,
      `globalThis.__plugin_exports = __isPluginModule(__default) ? __default : __plugin;`,
    ].join('\n')
  }
  return [
    `import __default from ${importPath};`,
    `globalThis.__module_pack = __default;`,
  ].join('\n')
}

async function bundleEntrypoint(
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
    const result = await Bun.build({
      entrypoints: [entryToBundle],
      target: 'browser',
      format: options.sandbox ? 'iife' : 'esm',
      splitting: false,
      minify: false,
      external,
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

/**
 * Walk `<sourceDir>/frontend/` and return every `.ts`/`.tsx` file as a
 * bundle target. Each source `frontend/<name>.{ts,tsx}` produces
 * `dist/frontend/<name>.js`. Files in nested directories are NOT bundled
 * automatically — only top-level files become assets, so a plugin can
 * keep helpers / types under `frontend/utils/` without producing dead
 * `dist/` output. Authors who need multiple bundles ship multiple
 * top-level files.
 */
async function listFrontendSources(sourceDir: string): Promise<Array<{ absolutePath: string; outputPath: string }>> {
  const frontendDir = join(sourceDir, 'frontend')
  if (!existsSync(frontendDir)) return []
  const out: Array<{ absolutePath: string; outputPath: string }> = []
  for (const entry of readdirSync(frontendDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue
    const match = /^(?<name>[^.][^/]*)\.(?:tsx?|m?js)$/.exec(entry.name)
    if (!match || !match.groups?.name) continue
    out.push({
      absolutePath: join(frontendDir, entry.name),
      outputPath: `frontend/${match.groups.name}.js`,
    })
  }
  out.sort((a, b) => (a.outputPath < b.outputPath ? -1 : a.outputPath > b.outputPath ? 1 : 0))
  return out
}

async function findEntrypoint(sourceDir: string, basename: string): Promise<string | null> {
  // Prefer .tsx so plugin entrypoints can use JSX directly.
  for (const ext of ['tsx', 'ts', 'js', 'mjs']) {
    const candidate = join(sourceDir, `${basename}.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  for (const ext of ['tsx', 'ts', 'js', 'mjs']) {
    const candidate = join(sourceDir, basename, `index.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function bundleAdminApps(
  sourceDir: string,
  outputDir: string,
  definition: PluginDefinition,
): Promise<void> {
  for (const page of definition.manifest.adminPages) {
    if (page.content.kind !== 'app') continue
    const entry = page.content.entry
    const sourceCandidate = join(sourceDir, entry)
    // Plugin source is .tsx (JSX) or .ts (no JSX). The manifest's `entry`
    // field always points at the BUNDLED output (.js); we resolve to one
    // of the typed sources here.
    const sourceTsx = sourceCandidate.replace(/\.js$/, '.tsx')
    const sourceTs = sourceCandidate.replace(/\.js$/, '.ts')
    const sourcePath = existsSync(sourceTsx)
      ? sourceTsx
      : existsSync(sourceTs)
        ? sourceTs
        : sourceCandidate
    if (!existsSync(sourcePath)) {
      throw new Error(`Admin app entry "${entry}" not found at ${sourcePath}`)
    }
    const outFile = join(outputDir, entry)
    await bundleEntrypoint(sourcePath, outFile)
  }
}

async function zipDirectory(sourceDir: string, zipPath: string): Promise<void> {
  await rm(zipPath, { force: true })
  await new Promise<void>((resolveZip, rejectZip) => {
    const child = spawn('zip', ['-qr', zipPath, '.'], {
      cwd: sourceDir,
      stdio: 'inherit',
    })
    child.on('exit', (code) => {
      if (code === 0) resolveZip()
      else rejectZip(new Error(`zip exited with code ${code}`))
    })
    child.on('error', rejectZip)
  })
}

export interface BuildPluginOptions {
  /** When false, skip producing the .plugin.zip (used by `instatic-plugin dev`). */
  zip?: boolean
}

export async function buildPlugin(
  sourceDir: string,
  options: BuildPluginOptions = {},
): Promise<PluginBuildResult> {
  const absoluteSource = resolve(sourceDir)
  const definition = await readPluginDefinition(absoluteSource)
  const distDir = join(absoluteSource, 'dist')

  await rm(distDir, { recursive: true, force: true })
  await mkdir(distDir, { recursive: true })

  // 1. Manifest — build entrypoint paths from what we'll emit.
  const entrypoints: NonNullable<typeof definition.manifest.entrypoints> = {}
  if (definition.modules.length > 0) {
    entrypoints.modules = 'modules/index.js'
  }
  const editorSource = await findEntrypoint(absoluteSource, 'editor')
  if (editorSource) entrypoints.editor = 'editor/index.js'
  const serverSource = await findEntrypoint(absoluteSource, 'server')
  if (serverSource) entrypoints.server = 'server/index.js'

  // Frontend assets are declared explicitly in the manifest's
  // `frontend.assets[]` array. The build doesn't need to invent a single
  // entrypoint anymore — instead it bundles every `.ts`/`.tsx` source under
  // `<sourceDir>/frontend/` to `<distDir>/frontend/<name>.js`. Authors
  // reference the built path from their `frontend.assets[]` declaration.
  const frontendSources = await listFrontendSources(absoluteSource)

  const finalManifest = {
    ...definition.manifest,
    entrypoints,
    ...(definition.pack ? { pack: { path: 'pack/site.json' } } : {}),
  }
  await writeFile(join(distDir, 'plugin.json'), JSON.stringify(finalManifest, null, 2), 'utf-8')

  // 2. Modules entrypoint — bundle a generated facade that re-exports every
  //    defined module via a default-exported array. The facade is written
  //    next to the plugin source (not under dist/) so its relative imports
  //    of `./modules/<file>` resolve correctly.
  if (definition.modules.length > 0) {
    const modulesFacade = generateModulesFacade(absoluteSource)
    const modulesFacadePath = join(absoluteSource, '__modules-facade.ts')
    await writeFile(modulesFacadePath, modulesFacade, 'utf-8')
    try {
      // Module packs are loaded by BOTH the browser editor (as an ES
      // module via dynamic import for the canvas preview) AND the server
      // (inside the QuickJS sandbox via `modulePackVm`). We emit ESM here;
      // `modulePackVm.ts` runtime-transforms `export default …` into a
      // `globalThis.__module_pack = …` assignment that QuickJS can eval.
      //
      // CRITICAL: `inlineHostRuntime: true` is what keeps the SDK helpers
      // (defineModule / control / html / raw / safeUrl) bundled in. The
      // sandbox path has no import map / no module resolver — without this
      // flag, bare `import { defineModule } from "@instatic/plugin-sdk"`
      // fails at activate time, the registry never receives the pack, and
      // the publisher emits `<!-- instatic: unknown module -->` on every page
      // that drops one of the plugin's modules.
      await bundleEntrypoint(modulesFacadePath, join(distDir, 'modules', 'index.js'), {
        inlineHostRuntime: true,
      })
    } finally {
      await rm(modulesFacadePath, { force: true })
    }
  }

  // 3. Editor / server / frontend entrypoints — passthrough bundle. Only
  //    the server entrypoint runs in the host's QuickJS sandbox; the rest
  //    run in the browser and externalize React + the host runtime
  //    packages so plugins share host React via the editor's import map.
  if (editorSource) await bundleEntrypoint(editorSource, join(distDir, 'editor', 'index.js'))
  if (serverSource) {
    await bundleEntrypoint(serverSource, join(distDir, 'server', 'index.js'), { sandbox: 'server' })
  }
  if (frontendSources.length > 0) {
    // Collect every package any module declared as a runtime dependency.
    // Frontend bundles that import those packages should leave the bare
    // specifier in place — the published page's `<script type="importmap">`
    // (emitted by the publisher from the site's lock) resolves them to
    // host-served URLs at runtime, so multiple plugins share one copy.
    const runtimeExternals = collectRuntimeExternals(definition.modules)
    for (const entry of frontendSources) {
      await bundleEntrypoint(
        entry.absolutePath,
        join(distDir, entry.outputPath),
        {
          frontendBundle: true,
          ...(runtimeExternals.length > 0 ? { externalSpecifiers: runtimeExternals } : {}),
        },
      )
    }
  }

  // 4. Admin apps — one bundle per declared app entry.
  await bundleAdminApps(absoluteSource, distDir, definition)

  // 5. Pack.
  if (definition.pack) {
    await mkdir(join(distDir, 'pack'), { recursive: true })
    await writeFile(
      join(distDir, 'pack', 'site.json'),
      JSON.stringify(definition.pack, null, 2),
      'utf-8',
    )
  }

  // 5b. Marketplace icon — passthrough copy. The manifest path is
  // validated by the schema (no `..` traversal, allowed extensions only),
  // so a missing file is the only realistic failure here.
  if (definition.manifest.icon) {
    const iconSource = join(absoluteSource, definition.manifest.icon)
    if (!existsSync(iconSource)) {
      throw new Error(`Plugin icon "${definition.manifest.icon}" not found at ${iconSource}`)
    }
    await copyFile(iconSource, join(distDir, definition.manifest.icon))
  }

  // 6. Zip — skipped during `dev` mode where the dist directory is synced
  //    directly into the host's uploads folder.
  let zipPath = ''
  if (options.zip !== false) {
    zipPath = join(dirname(absoluteSource), `${basename(absoluteSource)}.plugin.zip`)
    await zipDirectory(distDir, zipPath)
  }

  return {
    pluginId: definition.manifest.id,
    outputDir: distDir,
    zipPath,
  }
}

/**
 * Collect every non-dev package declared by any module in this plugin as a
 * runtime site dependency. These are the bare specifiers that the plugin's
 * frontend bundle should leave un-bundled — the published page resolves
 * them through its `<script type="importmap">`.
 */
function collectRuntimeExternals(modules: PluginDefinition['modules']): string[] {
  const externals = new Set<string>()
  for (const mod of modules) {
    const deps = mod.dependencies ?? {}
    for (const [name, spec] of Object.entries(deps)) {
      const dev = typeof spec === 'string' ? false : Boolean(spec.dev)
      if (!dev) externals.add(name)
    }
  }
  return [...externals].sort()
}

/**
 * Generate a tiny facade module that imports each module file in
 * `<src>/modules/`, collects the default exports, and re-exports them as a
 * single array. The facade is what gets bundled into `dist/modules/index.js`.
 *
 * Convention: every `.ts` file directly under `<src>/modules/` whose default
 * export is a `PluginModuleDefinition` becomes a registered module.
 */
function generateModulesFacade(sourceDir: string): string {
  const modulesDir = join(sourceDir, 'modules')
  if (!existsSync(modulesDir)) {
    throw new Error(`Plugin declares modules but ${modulesDir} does not exist`)
  }
  const files = readdirSync(modulesDir)
  const moduleFiles = files.filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.startsWith('index.'))
  if (moduleFiles.length === 0) {
    throw new Error(`No module files found under ${modulesDir}`)
  }
  const imports = moduleFiles
    .map((file, idx) => `import m${idx} from './modules/${file.replace(/\.(tsx?|m?js)$/, '')}'`)
    .join('\n')
  const defaultExport = `export default [${moduleFiles.map((_, idx) => `m${idx}`).join(', ')}]`
  return `${imports}\n${defaultExport}\n`
}
