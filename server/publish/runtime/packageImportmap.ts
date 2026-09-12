/**
 * Build a `<script type="importmap">` for a published page from a site's
 * locked runtime dependencies + the populated dep cache on disk.
 *
 *   ┌─ site.runtime.dependencyLock  (resolved versions, SRI, tarball URL)
 *   ├─ ensureRuntimeDependencyCache  (bun install → node_modules/)
 *   └─ buildRuntimePackageImportmap  ← we resolve each package's ESM entry
 *                                       to a `/_instatic/runtime/cache/<hash>/...`
 *                                       URL the host serves.
 *
 * Resolution rules per package (`pickEsmEntry` in `@core/registry`, shared
 * with the Dependencies panel's pre-install compatibility badge):
 *   1. If `package.json` has `exports['.']`, prefer the `import` / `module` /
 *      `default` condition (in that order).
 *   2. Else fall back to the `module` field, then `main`, then `index.js`.
 *   3. Subpaths (`three/examples/jsm/...`) resolve via the `<name>/` map entry
 *      that points at the package root.
 *
 * Returns null when:
 *   • the lock is empty
 *   • the cache directory or sentinel is missing — caller should
 *     `ensureRuntimeDependencyCache(lock)` first
 *   • a declared package has no resolvable ESM entry (we log + skip)
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SiteDependencyLock } from '@core/site-runtime'
import { packageEntryUrlPath, pickEsmEntry } from '@core/registry'
import {
  nodeModulesDirForHash,
  runtimeDependencyLockHash,
  sentinelPathForHash,
  type RuntimeDependencyCache,
} from './dependencyCache'

interface RuntimePackageImportmap {
  /** JSON-serializable importmap body. */
  importmap: { imports: Record<string, string> }
  /** Stable cache-lock hash — same value the URL paths embed. */
  lockHash: string
}

async function readPackageJson(packageDir: string): Promise<Record<string, unknown> | null> {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return null
  try {
    const raw = await readFile(manifestPath, 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch (err) {
    console.warn('[runtime importmap] failed to parse', manifestPath, err)
    return null
  }
}

/**
 * Resolve a package's main ESM entry to a path relative to the package root.
 * Returns `'/index.js'` only if nothing in `package.json` indicates otherwise.
 */
async function resolvePackageEntry(packageDir: string): Promise<string | null> {
  const manifest = await readPackageJson(packageDir)
  if (!manifest) return null

  const entry = pickEsmEntry(manifest)
  if (entry) return packageEntryUrlPath(entry)

  // Final fallback — CommonJS index. Browsers won't load CJS as ESM but it's
  // the lowest-noise default; the user will see a runtime error pointing at
  // the missing package rather than a silent 404 here.
  return '/index.js'
}

interface BuildPackageImportmapOptions {
  /** URL prefix the host serves the cache from. Defaults to `/_instatic/runtime/cache/`. */
  cacheUrlPrefix?: string
}

/**
 * Build the importmap from a populated dependency cache. The caller is
 * responsible for running `ensureRuntimeDependencyCache(lock)` first; this
 * function only reads the on-disk node_modules layout.
 */
export async function buildRuntimePackageImportmap(
  lock: SiteDependencyLock,
  cache: Pick<RuntimeDependencyCache, 'hash' | 'nodeModulesDir'>,
  options: BuildPackageImportmapOptions = {},
): Promise<RuntimePackageImportmap | null> {
  const lockedNames = Object.keys(lock.packages)
  if (lockedNames.length === 0) return null

  const prefix = options.cacheUrlPrefix ?? '/_instatic/runtime/cache/'
  const baseUrl = `${prefix.replace(/\/+$/g, '')}/${cache.hash}/`

  const imports: Record<string, string> = {}
  for (const name of lockedNames.sort()) {
    const packageDir = join(cache.nodeModulesDir, name)
    if (!existsSync(packageDir)) {
      console.warn(`[runtime importmap] cache missing "${name}" — skipping`)
      continue
    }
    const entry = await resolvePackageEntry(packageDir)
    if (!entry) continue
    imports[name] = `${baseUrl}${name}${entry}`
    // Subpath entry: `import { OrbitControls } from 'three/examples/jsm/...'`
    // resolves to `<base>three/examples/jsm/...` so the addon files reach the
    // same on-disk package via the same hash + name.
    imports[`${name}/`] = `${baseUrl}${name}/`
  }

  if (Object.keys(imports).length === 0) return null

  return {
    importmap: { imports },
    lockHash: cache.hash,
  }
}

/**
 * Hash the importmap JSON exactly the way the browser will parse it, for use
 * in CSP `script-src 'sha256-<hash>'`. The browser computes the hash over the
 * raw script tag contents, so we serialise once and hand the same string to
 * both the CSP builder and the HTML emitter.
 */
export async function serializeImportmapForCsp(
  importmap: { imports: Record<string, string> },
): Promise<{ body: string; sha256: string }> {
  // Deterministic JSON: 2-space pretty-print to match what we emit into the
  // page. The browser hashes the literal script tag text bytes.
  const body = JSON.stringify(importmap, null, 2)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  const sha256 = base64FromArrayBuffer(digest)
  return { body, sha256 }
}

function base64FromArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Convenience wrapper for callers that have the lock but no cache handle —
 * computes the hash and assumes the standard cache dir layout. The on-disk
 * cache must exist (and have its sentinel file); otherwise returns null.
 */
export async function buildRuntimePackageImportmapFromLock(
  lock: SiteDependencyLock,
  options: BuildPackageImportmapOptions & { cacheRoot?: string } = {},
): Promise<RuntimePackageImportmap | null> {
  const hash = runtimeDependencyLockHash(lock)
  if (!existsSync(sentinelPathForHash(hash, options.cacheRoot))) return null

  return buildRuntimePackageImportmap(
    lock,
    { hash, nodeModulesDir: nodeModulesDirForHash(hash, options.cacheRoot) },
    options,
  )
}
