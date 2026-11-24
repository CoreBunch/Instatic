/**
 * `instatic-plugin dev` — watch source files, rebuild, and sync into the host's
 * `<uploadsDir>/plugins/<id>/<version>/` directly.
 *
 * Mechanics:
 *   1. Resolve the host's uploads dir (CLI flag → env → auto-detect).
 *   2. Run an initial `buildPlugin()` (no zip).
 *   3. Sync `dist/` → `<uploadsDir>/plugins/<id>/<version>/`.
 *   4. Watch the plugin source folder. On every change, rebuild + re-sync.
 *
 * The host doesn't need to be told anything happened — its server module
 * loader cache-busts each `import()` with `?v=Date.now()`, so the next
 * request that touches a plugin's server hook sees the fresh code. Editor
 * and frontend bundles still need a manual page reload (browser cache).
 */
import { statSync, watch } from 'node:fs'
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { buildPlugin, isBuildScratchFile } from './build'
import {
  resolvePluginDevConfig,
  type PluginDevTargets,
} from './config'

export interface PluginDevOptions {
  pluginDir: string
  /** CLI flag override for the uploads directory. */
  uploadsDirFlag?: string
}

export async function runPluginDev(options: PluginDevOptions): Promise<void> {
  const pluginDir = resolve(options.pluginDir)
  const targets = resolvePluginDevConfig({
    pluginDir,
    uploadsDirFlag: options.uploadsDirFlag,
  })

  console.log(`▶ instatic-plugin dev`)
  console.log(`  source: ${pluginDir}`)
  console.log(`  uploads: ${targets.uploadsDir} (${targets.source})`)
  console.log()

  await rebuildAndSync(pluginDir, targets, { initial: true })

  // Watch source — ignore what the build itself writes, or each rebuild
  // would trigger the next one.
  const watcher = watch(pluginDir, { recursive: true }, (_event, fileName) => {
    if (!fileName) return
    if (shouldIgnoreChange(pluginDir, fileName)) return
    void debounce(async () => {
      try {
        await rebuildAndSync(pluginDir, targets, { initial: false, changed: fileName })
      } catch (err) {
        console.error(`  ✗ rebuild failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  })

  // Keep the process alive until the user Ctrl+Cs.
  await new Promise<void>((resolveProcess) => {
    process.on('SIGINT', () => {
      watcher.close()
      console.log('\n▶ instatic-plugin dev — stopped.')
      resolveProcess()
    })
  })
}

/**
 * Whether a watcher event for `fileName` (relative to `pluginDir`) is not a
 * source edit: the build output in `dist/`, the facades the build writes next
 * to the sources, dependencies, git metadata, or a folder whose listing changed.
 * `fs.watch` reports paths with the platform separator (`dist\modules\index.js`
 * on Windows), so the path is split on both.
 */
export function shouldIgnoreChange(pluginDir: string, fileName: string): boolean {
  const segments = fileName.split(/[\\/]+/).filter(Boolean)
  const name = segments[segments.length - 1] ?? ''
  if (segments[0] === 'dist') return true
  if (segments.some((segment) => segment === 'node_modules' || segment === '.git')) return true
  if (name === '.DS_Store' || isBuildScratchFile(name)) return true
  // Windows also reports the folder itself when a file inside it is created or
  // removed (`server` around each sandbox facade). A real edit always reports
  // the file too, so a folder event alone never needs a rebuild.
  return statSync(join(pluginDir, fileName), { throwIfNoEntry: false })?.isDirectory() ?? false
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
async function debounce(fn: () => Promise<void>, delay = 100): Promise<void> {
  if (debounceTimer) clearTimeout(debounceTimer)
  await new Promise<void>((resolveDebounce) => {
    debounceTimer = setTimeout(async () => {
      debounceTimer = null
      await fn()
      resolveDebounce()
    }, delay)
  })
}

interface RebuildContext {
  initial: boolean
  changed?: string
}

async function rebuildAndSync(
  pluginDir: string,
  targets: PluginDevTargets,
  ctx: RebuildContext,
): Promise<void> {
  const startedAt = Date.now()
  if (ctx.initial) {
    process.stdout.write('  → building...')
  } else {
    process.stdout.write(`  → ${ctx.changed} → rebuild...`)
  }

  const result = await buildPlugin(pluginDir, { zip: false })

  // Mirror result.outputDir into <uploadsDir>/plugins/<id>/<version>/.
  const versionDir = await resolveVersionDir(targets, result.pluginId, result.outputDir)
  await syncDir(result.outputDir, versionDir)

  const elapsed = Date.now() - startedAt
  process.stdout.write(` ${elapsed}ms\n`)
  if (ctx.initial) {
    console.log(`  → synced to ${relative(pluginDir, versionDir)}`)
    console.log()
  }
}

/**
 * Pick the `<uploadsDir>/plugins/<id>/<version>/` directory matching the
 * built plugin's manifest. We read the manifest from the just-built
 * `dist/plugin.json` so the version field is authoritative.
 */
async function resolveVersionDir(
  targets: PluginDevTargets,
  pluginId: string,
  distDir: string,
): Promise<string> {
  const manifestPath = join(distDir, 'plugin.json')
  const manifest = JSON.parse(await Bun.file(manifestPath).text()) as { version: string }
  return join(targets.uploadsDir, 'plugins', pluginId, manifest.version)
}

/**
 * Recursive sync from `src` → `dst`. Removes orphan files in `dst` that
 * aren't in `src` so a deleted plugin file doesn't linger after a rebuild.
 */
async function syncDir(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true })

  // Copy everything from src to dst. `cp` with recursive + force is
  // idempotent and preserves nested dir structure.
  await cp(src, dst, { recursive: true, force: true })

  // Drop files that exist in dst but not in src — handles deletions.
  await dropOrphans(src, dst)
}

async function dropOrphans(src: string, dst: string): Promise<void> {
  const dstEntries = await readdir(dst, { withFileTypes: true })
  for (const entry of dstEntries) {
    const dstPath = join(dst, entry.name)
    const srcPath = join(src, entry.name)
    let srcExists: boolean
    try {
      await stat(srcPath)
      srcExists = true
    } catch {
      srcExists = false
    }
    if (!srcExists) {
      await rm(dstPath, { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      await dropOrphans(srcPath, dstPath)
    }
  }
}

// Suppress unused warning for `basename` — used by callers in CLI traces.
void basename
