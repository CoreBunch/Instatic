/**
 * Plugin build pipeline — the CLI frontend of `@core/plugin-build`.
 *
 * Reads `<dir>/instatic-plugin.config.ts`, evaluates it via `import()` (Bun
 * transpiles TypeScript natively — this runs the AUTHOR'S OWN code on the
 * author's machine, which is why config evaluation lives here and never in
 * the server-side site plugin build), derives the final manifest, and hands
 * the bundling to the shared `buildPluginPackage` core. The zip layout the
 * host package installer expects:
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
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import type { PluginDefinition } from '../builders/definePlugin'
import type { PluginManifest } from '../types'
import { buildPluginPackage, findEntrypoint } from '@core/plugin-build'
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

  // 1. Manifest — build entrypoint paths from what the core will emit.
  const entrypoints: NonNullable<typeof definition.manifest.entrypoints> = {}
  if (definition.modules.length > 0) {
    entrypoints.modules = 'modules/index.js'
  }
  if (findEntrypoint(absoluteSource, 'editor')) entrypoints.editor = 'editor/index.js'
  if (findEntrypoint(absoluteSource, 'server')) entrypoints.server = 'server/index.js'

  const finalManifest: PluginManifest = {
    ...definition.manifest,
    entrypoints,
    ...(definition.pack ? { pack: { path: 'pack/site.json' } } : {}),
  }

  // 2. Shared core — plugin.json + every entrypoint/frontend/admin bundle.
  //    Frontend bundles leave module runtime dependencies external; the
  //    published page's `<script type="importmap">` (emitted by the
  //    publisher from the site's lock) resolves them so multiple plugins
  //    share one copy.
  await buildPluginPackage({
    sourceDir: absoluteSource,
    outputDir: distDir,
    manifest: finalManifest,
    frontendExternalSpecifiers: collectRuntimeExternals(definition.modules),
  })

  // 3. Pack.
  if (definition.pack) {
    await mkdir(join(distDir, 'pack'), { recursive: true })
    await writeFile(
      join(distDir, 'pack', 'site.json'),
      JSON.stringify(definition.pack, null, 2),
      'utf-8',
    )
  }

  // 3b. Marketplace icon — passthrough copy. The manifest path is
  // validated by the schema (no `..` traversal, allowed extensions only),
  // so a missing file is the only realistic failure here.
  if (definition.manifest.icon) {
    const iconSource = join(absoluteSource, definition.manifest.icon)
    if (!existsSync(iconSource)) {
      throw new Error(`Plugin icon "${definition.manifest.icon}" not found at ${iconSource}`)
    }
    await copyFile(iconSource, join(distDir, definition.manifest.icon))
  }

  // 4. Zip — skipped during `dev` mode where the dist directory is synced
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
