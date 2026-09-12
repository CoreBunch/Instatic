/**
 * `buildPluginPackage` — the shared, pure plugin-package builder.
 *
 * Takes a fully-derived manifest plus an on-disk source workspace and emits
 * the runtime package layout (`plugin.json` + per-surface bundles). Two
 * frontends drive it:
 *
 *   - the CLI (`instatic-plugin build|dev`) — evaluates the author's
 *     `instatic-plugin.config.ts` on the author's own machine, derives the
 *     manifest, then calls this core;
 *   - the server-side site plugin build — materializes draft `SiteFile[]`
 *     source into a temp workspace, derives the manifest from the draft
 *     `plugin.json`, and calls this core with a fail-closed
 *     `ImportResolverPolicy` (the host must never let draft code read
 *     outside its own folder).
 *
 * The core knows nothing about zips, dist directories, packs, or icons —
 * those stay with the callers.
 */
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PluginManifest } from '@core/plugin-sdk'
import { bundleEntrypoint } from './bundle'
import type { ImportResolverPolicy } from './containment'
import { generateModulesFacade } from './facades'

export interface BuildPackageInput {
  /** Absolute dir containing the plugin source (server/, editor/, frontend/, modules/…). */
  sourceDir: string
  /** Absolute dir to write the package into (plugin.json + bundles). */
  outputDir: string
  /** Fully-derived, already-validated manifest to serialize as plugin.json. */
  manifest: PluginManifest
  resolve?: ImportResolverPolicy
  /**
   * Bare specifiers frontend bundles leave external (resolved by the
   * published page's `<script type="importmap">`). The CLI derives these
   * from module runtime dependencies; site plugin builds pass none in v1.
   */
  frontendExternalSpecifiers?: string[]
}

export interface BuildPackageResult {
  /** Package-relative paths written (plugin.json first). */
  files: string[]
}

/**
 * Find an entrypoint source file for `basename` under `sourceDir`:
 * `<basename>.{tsx,ts,js,mjs}` first, then `<basename>/index.{tsx,ts,js,mjs}`.
 * Prefers `.tsx` so plugin entrypoints can use JSX directly.
 */
export function findEntrypoint(sourceDir: string, basename: string): string | null {
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

/**
 * Walk `<sourceDir>/frontend/` and return every `.ts`/`.tsx`/`.js`/`.mjs`
 * file as a bundle target. Each source `frontend/<name>.<ext>` produces
 * `frontend/<name>.js` in the package. Files in nested directories are NOT
 * bundled automatically — only top-level files become assets, so a plugin
 * can keep helpers / types under `frontend/utils/` without producing dead
 * output. Authors who need multiple bundles ship multiple top-level files.
 */
export function listFrontendSources(
  sourceDir: string,
): Array<{ absolutePath: string; outputPath: string }> {
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

/**
 * Build the runtime package: write `plugin.json`, then bundle every surface
 * the manifest declares — modules facade (inlined host runtime), editor
 * (host externals), server (QuickJS sandbox IIFE), top-level frontend
 * sources, and admin app entries. Missing sources for declared entrypoints
 * fail loudly.
 */
export async function buildPluginPackage(input: BuildPackageInput): Promise<BuildPackageResult> {
  const { sourceDir, outputDir, manifest } = input
  const files: string[] = []

  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  files.push('plugin.json')

  const entrypoints = manifest.entrypoints ?? {}

  // Modules entrypoint — bundle a generated facade that re-exports every
  // module file's default export as one array. The facade is written next
  // to the plugin source (not under the output dir) so its relative
  // `./modules/<file>` imports resolve correctly.
  if (entrypoints.modules) {
    const modulesFacade = generateModulesFacade(sourceDir)
    const modulesFacadePath = join(sourceDir, '__modules-facade.ts')
    await writeFile(modulesFacadePath, modulesFacade, 'utf-8')
    try {
      // Module packs are loaded by BOTH the browser editor (as an ES module
      // via dynamic import for the canvas preview) AND the server (inside
      // the QuickJS sandbox via `modulePackVm`). We emit ESM here;
      // `modulePackVm.ts` runtime-transforms `export default …` into a
      // `globalThis.__module_pack = …` assignment that QuickJS can eval.
      // `inlineHostRuntime: true` keeps the SDK helpers bundled in — the
      // sandbox path has no import map / module resolver.
      await bundleEntrypoint(modulesFacadePath, join(outputDir, entrypoints.modules), {
        inlineHostRuntime: true,
        // Diagnostics name the author's module file via their position; the
        // header must not point at the synthetic facade.
        label: 'the modules pack (modules/*)',
        ...(input.resolve ? { resolve: input.resolve } : {}),
      })
      files.push(entrypoints.modules)
    } finally {
      await rm(modulesFacadePath, { force: true })
    }
  }

  // Editor entrypoint — runs in the admin window; shares host React + UI
  // via the editor's import map (HOST_RUNTIME_EXTERNALS).
  if (entrypoints.editor) {
    const editorSource = findEntrypoint(sourceDir, 'editor')
    if (!editorSource) {
      throw new Error(`Manifest declares entrypoints.editor but no editor/index.{tsx,ts,js,mjs} source exists`)
    }
    await bundleEntrypoint(editorSource, join(outputDir, entrypoints.editor), {
      ...(input.resolve ? { resolve: input.resolve } : {}),
    })
    files.push(entrypoints.editor)
  }

  // Server entrypoint — QuickJS sandbox IIFE, self-contained, scanned.
  if (entrypoints.server) {
    const serverSource = findEntrypoint(sourceDir, 'server')
    if (!serverSource) {
      throw new Error(`Manifest declares entrypoints.server but no server/index.{tsx,ts,js,mjs} source exists`)
    }
    await bundleEntrypoint(serverSource, join(outputDir, entrypoints.server), {
      sandbox: 'server',
      ...(input.resolve ? { resolve: input.resolve } : {}),
    })
    files.push(entrypoints.server)
  }

  // Frontend sources — every top-level file under frontend/ becomes a
  // published-page bundle (no host import map there).
  const frontendSources = listFrontendSources(sourceDir)
  const frontendExternals = input.frontendExternalSpecifiers ?? []
  for (const entry of frontendSources) {
    await bundleEntrypoint(entry.absolutePath, join(outputDir, entry.outputPath), {
      frontendBundle: true,
      ...(frontendExternals.length > 0 ? { externalSpecifiers: frontendExternals } : {}),
      ...(input.resolve ? { resolve: input.resolve } : {}),
    })
    files.push(entry.outputPath)
  }

  // Frontend stylesheets — style assets are static files (never bundled);
  // copy top-level frontend/*.css through so `frontend.assets[]` style
  // declarations resolve in the package.
  const frontendDir = join(sourceDir, 'frontend')
  if (existsSync(frontendDir)) {
    for (const entry of readdirSync(frontendDir, { withFileTypes: true })) {
      if (entry.isDirectory() || !entry.name.endsWith('.css')) continue
      const outputPath = `frontend/${entry.name}`
      await mkdir(join(outputDir, 'frontend'), { recursive: true })
      await copyFile(join(frontendDir, entry.name), join(outputDir, outputPath))
      files.push(outputPath)
    }
  }

  // Pack contents — a static JSON file in the source tree (site plugin
  // builds materialize it from the draft). The CLI writes its pack from the
  // evaluated config AFTER this core runs, so a missing source file is
  // skipped, not an error.
  if (manifest.pack && existsSync(join(sourceDir, manifest.pack.path))) {
    const packOut = join(outputDir, manifest.pack.path)
    await mkdir(dirname(packOut), { recursive: true })
    await copyFile(join(sourceDir, manifest.pack.path), packOut)
    files.push(manifest.pack.path)
  }

  // Admin app pages — one bundle per declared app entry. The manifest's
  // `entry` field points at the BUNDLED output (.js); resolve the typed
  // source next to it.
  for (const page of manifest.adminPages) {
    if (page.content.kind !== 'app') continue
    const entry = page.content.entry
    const sourceCandidate = join(sourceDir, entry)
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
    await bundleEntrypoint(sourcePath, join(outputDir, entry), {
      ...(input.resolve ? { resolve: input.resolve } : {}),
    })
    files.push(entry)
  }

  return { files }
}
