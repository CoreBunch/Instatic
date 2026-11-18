import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { packageEntryUrlPath, pickEsmEntry } from '@core/registry'
import type { SiteDependencyLock } from '@core/site-runtime'
import { safeParseJson } from '@core/utils/jsonValidate'
import { readRuntimeCacheDir } from '../../config'
import { isPublicNpmRegistry, npmRegistryUrl } from '../../registry/config'

export interface RuntimeDependencyCache {
  hash: string
  workspaceDir: string
  nodeModulesDir: string
}

interface RuntimeInstallOptions {
  cwd: string
  env: Record<string, string>
  signal?: AbortSignal
}

export type RuntimeInstallRunner = (
  command: string[],
  options: RuntimeInstallOptions,
) => Promise<void>

interface EnsureRuntimeDependencyCacheOptions {
  cacheRoot?: string
  bunExecutable?: string
  runInstall?: RuntimeInstallRunner
  /** Override the install timeout (ms). Mainly for tests. */
  installTimeoutMs?: number
  /** Override the package-count cap. Mainly for tests. */
  maxPackages?: number
}

/**
 * Sentinel file written inside the workspace dir AFTER a successful install.
 * It proves the install finished: `existsSync` on the bare `node_modules/`
 * directory is unreliable because a partial install (interrupted child
 * process, watcher reload, pipe deadlock) can leave the directory created but
 * only sparsely populated.
 *
 * The sentinel alone does NOT prove the entry is still usable. A cache root
 * that an operator pointed at a temp folder is swept by temp cleaners (macOS
 * periodic cleanup, `systemd-tmpfiles`), which delete the installed files
 * while leaving the directories and this marker behind.
 * `isRuntimeDependencyCacheIntact` is the check that decides whether an entry
 * may be trusted.
 *
 * The marker records, per locked package, the entry file the importmap serves
 * (`entries`), so the integrity check can confirm those files without parsing
 * every package manifest on each publish or serve.
 */
const INSTALL_SENTINEL_FILE = '.instatic-install-complete'

const InstallSentinelSchema = Type.Object({
  hash: Type.String(),
  completedAt: Type.Number(),
  packageCount: Type.Number(),
  /** Locked package name → served entry path (`/dist/index.js`), recorded only when that file existed at install. */
  entries: Type.Record(Type.String(), Type.String()),
})

/**
 * Hard upper bound on packages declared in a single dependency lock. A site
 * needing more than this is almost certainly a misconfiguration or an attempt
 * to exhaust install capacity. The cap is generous for legitimate sites
 * (sites typically use 1–20 runtime packages).
 */
const DEFAULT_MAX_RUNTIME_PACKAGES = 100

/**
 * Hard upper bound on the time a single `bun install` invocation may run.
 * Without this, a stuck registry lookup or hung child process pins the request
 * and ties up server capacity indefinitely.
 */
const DEFAULT_INSTALL_TIMEOUT_MS = 60_000

function sortedExactDependencies(lock: SiteDependencyLock): Record<string, string> {
  return Object.fromEntries(
    Object.values(lock.packages)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((dependency) => [dependency.name, dependency.version]),
  )
}

export function runtimeDependencyLockHash(lock: SiteDependencyLock): string {
  const exactDependencies = sortedExactDependencies(lock)
  const payload = JSON.stringify(exactDependencies)
  return createHash('sha256').update(payload).digest('hex').slice(0, 24)
}

// ---------------------------------------------------------------------------
// On-disk cache layout — the single owner of the cache path contract.
//
// The writer (`performInstall`) and every reader (`packageServer.ts`,
// `packageImportmap.ts`) MUST derive paths through these accessors. Changing
// the env var, the `deps/` segment, the node_modules location, or the sentinel
// filename here updates writer and readers together — they can never disagree.
// ---------------------------------------------------------------------------

/**
 * Root of the runtime dependency cache: `RUNTIME_CACHE_DIR`, or `runtime-cache/`
 * in the instance state directory. Read from the environment on every call;
 * `readRuntimeCacheDir` in `server/config.ts` owns the rule.
 */
export function cacheRootDir(): string {
  return readRuntimeCacheDir()
}

/** Directory holding all per-hash workspaces under a cache root. */
function depsDir(cacheRoot: string): string {
  return join(cacheRoot, 'deps')
}

/** Content-addressed workspace dir for a given lock hash. */
export function workspaceDirForHash(hash: string, cacheRoot: string = cacheRootDir()): string {
  return join(depsDir(cacheRoot), hash)
}

/** Installed-packages dir for a given lock hash. */
export function nodeModulesDirForHash(hash: string, cacheRoot: string = cacheRootDir()): string {
  return join(workspaceDirForHash(hash, cacheRoot), 'node_modules')
}

/** Path to the install-complete sentinel for a given lock hash. */
export function sentinelPathForHash(hash: string, cacheRoot: string = cacheRootDir()): string {
  return join(workspaceDirForHash(hash, cacheRoot), INSTALL_SENTINEL_FILE)
}

/** Only the top-level object shape matters; `pickEsmEntry` reads the fields it needs defensively. */
const PackageManifestSchema = Type.Record(Type.String(), Type.Unknown())

/**
 * Resolve the entry file the importmap serves for an installed package, as a
 * `/relative/path.js` under the package root. Returns null when the package
 * has no readable `package.json`. Uses `pickEsmEntry` (shared with the
 * Dependencies panel) and falls back to `/index.js` when the manifest names no
 * entry at all: browsers will not load a CommonJS index as ESM, but a runtime
 * error naming the package is clearer than a silent gap in the importmap.
 */
export function resolveInstalledPackageEntry(packageDir: string): string | null {
  const manifestPath = join(packageDir, 'package.json')
  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch (_err) {
    // Missing or unreadable manifest: the package is not usable from the cache.
    return null
  }
  const parsed = safeParseJson(raw, PackageManifestSchema)
  if (!parsed.ok) {
    console.warn('[runtime dependency cache] failed to parse', manifestPath)
    return null
  }
  const entry = pickEsmEntry(parsed.value)
  return entry ? packageEntryUrlPath(entry) : '/index.js'
}

/**
 * Locked packages whose `package.json` is missing from an entry's
 * `node_modules`. Empty means every locked package is still installed.
 */
function missingLockedPackages(lock: SiteDependencyLock, nodeModulesDir: string): string[] {
  return Object.keys(sortedExactDependencies(lock)).filter(
    (name) => !existsSync(join(nodeModulesDir, name, 'package.json')),
  )
}

/**
 * The served entry of every locked package whose entry file exists right
 * after install. A package whose resolved entry is not on disk (a CSS-only
 * package, an extensionless `main`) is left out rather than failing the
 * install, so it cannot make a fresh entry look broken forever.
 */
function servedEntries(lock: SiteDependencyLock, nodeModulesDir: string): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const name of Object.keys(sortedExactDependencies(lock))) {
    const packageDir = join(nodeModulesDir, name)
    const entry = resolveInstalledPackageEntry(packageDir)
    if (entry && existsSync(join(packageDir, entry))) entries[name] = entry
  }
  return entries
}

/**
 * Whether the cache entry for `lock` can be trusted: the install finished
 * (marker present and readable), and every locked package still has its
 * `package.json` and the entry file it serves under `node_modules`. A temp
 * cleaner that ages files out by access time removes the rarely read build
 * files (`dist/index.js`) before the `package.json` the importmap reads on
 * every build, so the manifest alone does not prove the package still works.
 * An entry that fails this is reinstalled by `ensureRuntimeDependencyCache`.
 *
 * Cheap enough for publish and serve paths: one small marker read plus two
 * `existsSync` calls per locked package, no manifest parsing.
 */
export function isRuntimeDependencyCacheIntact(
  lock: SiteDependencyLock,
  cacheRoot: string = cacheRootDir(),
): boolean {
  const hash = runtimeDependencyLockHash(lock)
  let raw: string
  try {
    raw = readFileSync(sentinelPathForHash(hash, cacheRoot), 'utf8')
  } catch (_err) {
    // No marker: the install never finished, or the marker was cleaned away.
    return false
  }
  // A marker from before `entries` was recorded fails the schema, so that
  // entry is reinstalled once and gains the per-package entry list.
  const sentinel = safeParseJson(raw, InstallSentinelSchema)
  if (!sentinel.ok || sentinel.value.hash !== hash) return false

  const nodeModulesDir = nodeModulesDirForHash(hash, cacheRoot)
  if (missingLockedPackages(lock, nodeModulesDir).length > 0) return false
  return Object.entries(sentinel.value.entries).every(
    ([name, entry]) => existsSync(join(nodeModulesDir, name, entry)),
  )
}

async function defaultRunInstall(command: string[], options: RuntimeInstallOptions): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Honor an external abort (used to enforce the install timeout). Killing
  // the child causes `proc.exited` to resolve with a non-zero exit code below,
  // which we surface as a clean error message.
  const onAbort = () => {
    try {
      proc.kill()
    } catch {
      // The process may already have exited; that's fine.
    }
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    // Drain stdout/stderr concurrently with awaiting exit. Without this, a
    // noisy child process can fill the pipe buffer and block waiting for
    // someone to read it — never reaching the exit syscall — which would
    // leave us with a partially extracted node_modules/ tree.
    const [exitCode, stdoutText, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (exitCode === 0) return

    if (options.signal?.aborted) {
      throw new Error('[runtime dependency cache] install timed out')
    }
    throw new Error(
      `[runtime dependency cache] install failed (${exitCode}): ${stderrText || stdoutText}`,
    )
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}

function tempWorkspaceDir(cacheRoot: string, hash: string): string {
  // Process pid + random suffix avoids collisions between concurrent server
  // requests racing to populate the same lock hash. See INSTALL_SENTINEL_FILE
  // comment for why a fixed-name workspace dir was unsafe.
  const random = randomBytes(6).toString('hex')
  return join(depsDir(cacheRoot), `.tmp-${hash}-${process.pid}-${random}`)
}

async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/**
 * In-process map of installs currently running, keyed by lock hash. Two
 * concurrent requests for the same dependency set share the same install
 * promise instead of each spawning their own child process — important for
 * preview, where many incremental edits can fan out into duplicate builds.
 */
const inFlightInstalls = new Map<string, Promise<RuntimeDependencyCache>>()

async function performInstall(
  lock: SiteDependencyLock,
  options: EnsureRuntimeDependencyCacheOptions,
): Promise<RuntimeDependencyCache> {
  const hash = runtimeDependencyLockHash(lock)
  const cacheRoot = options.cacheRoot ?? cacheRootDir()
  const workspaceDir = workspaceDirForHash(hash, cacheRoot)
  const nodeModulesDir = nodeModulesDirForHash(hash, cacheRoot)

  // Fast path: the install completed and its packages are still on disk.
  if (isRuntimeDependencyCacheIntact(lock, cacheRoot)) {
    return { hash, workspaceDir, nodeModulesDir }
  }

  // Slow path: install atomically. We materialize the workspace into a temp
  // sibling dir, run `bun install`, write the sentinel marker, and only then
  // rename the temp dir into its final hash-based slot. A partial install
  // therefore never appears as a valid cache entry — the next request will
  // simply re-attempt the install. An existing entry that failed the check
  // above (never finished, or hollowed out by a temp cleaner) is replaced by
  // the same rename.
  const exactDependencies = sortedExactDependencies(lock)
  const maxPackages = options.maxPackages ?? DEFAULT_MAX_RUNTIME_PACKAGES
  if (Object.keys(exactDependencies).length > maxPackages) {
    throw new Error(
      `[runtime dependency cache] too many runtime packages (${Object.keys(exactDependencies).length}); max is ${maxPackages}`,
    )
  }

  const tempDir = tempWorkspaceDir(cacheRoot, hash)

  await mkdir(tempDir, { recursive: true })

  try {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      private: true,
      name: `instatic-runtime-${hash}`,
      version: '0.0.0',
      type: 'module',
      dependencies: exactDependencies,
    }, null, 2), 'utf8')

    const installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), installTimeoutMs)
    try {
      const command = [options.bunExecutable ?? process.execPath, 'install', '--ignore-scripts']
      // The same registry the resolver read metadata from — a private mirror
      // configured through NPM_REGISTRY_URL must also serve the tarballs.
      const registryUrl = npmRegistryUrl()
      await (options.runInstall ?? defaultRunInstall)(command, {
        cwd: tempDir,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          BUN_CONFIG_IGNORE_SCRIPTS: '1',
          ...(isPublicNpmRegistry(registryUrl) ? {} : { NPM_CONFIG_REGISTRY: registryUrl }),
        },
        signal: abort.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    // An install that exits 0 without the locked packages on disk would be
    // reinstalled on every request; fail it here with the reason instead.
    const missing = missingLockedPackages(lock, join(tempDir, 'node_modules'))
    if (missing.length > 0) {
      throw new Error(
        `[runtime dependency cache] install finished without ${missing.join(', ')}`,
      )
    }

    // Sentinel goes inside the temp dir at the location it will live after the
    // rename, so the renamed directory is already a "valid" cache from the
    // first instant it is observable at the final path.
    const sentinel: Static<typeof InstallSentinelSchema> = {
      hash,
      completedAt: Date.now(),
      packageCount: Object.keys(exactDependencies).length,
      entries: servedEntries(lock, join(tempDir, 'node_modules')),
    }
    await writeFile(join(tempDir, INSTALL_SENTINEL_FILE), JSON.stringify(sentinel), 'utf8')

    try {
      await rename(tempDir, workspaceDir)
    } catch {
      // Rename failed — most likely because the target already exists. Two
      // sub-cases:
      //   1. Another process won the race and produced a valid cache. Drop
      //      our temp and use theirs.
      //   2. The target is a broken cache (no sentinel, or its packages are
      //      gone). Remove it and retry once.
      if (isRuntimeDependencyCacheIntact(lock, cacheRoot)) {
        await removeIfExists(tempDir)
      } else {
        await removeIfExists(workspaceDir)
        await rename(tempDir, workspaceDir)
      }
    }
  } catch (err) {
    await removeIfExists(tempDir)
    throw err
  }

  return { hash, workspaceDir, nodeModulesDir }
}

export async function ensureRuntimeDependencyCache(
  lock: SiteDependencyLock,
  options: EnsureRuntimeDependencyCacheOptions = {},
): Promise<RuntimeDependencyCache> {
  const hash = runtimeDependencyLockHash(lock)

  // Concurrency dedupe: if a request for this exact lock is already running,
  // join it instead of spawning a duplicate `bun install`. This collapses the
  // thundering-herd that happens when several preview rebuilds queue up
  // before the first install completes.
  const existing = inFlightInstalls.get(hash)
  if (existing) return existing

  const promise = performInstall(lock, options)
  inFlightInstalls.set(hash, promise)
  try {
    return await promise
  } finally {
    inFlightInstalls.delete(hash)
  }
}
