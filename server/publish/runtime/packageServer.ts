/**
 * HTTP handler for `/_instatic/runtime/cache/<hash>/<...path>` — serves files from a
 * site's local runtime dependency cache.
 *
 * Why this exists
 * ───────────────
 * `ensureRuntimeDependencyCache(lock)` runs `bun install` against the site's
 * locked dependencies in a content-addressed workspace dir
 * (`<cacheRoot>/deps/<hash>/`). Published pages need to *fetch* those installed
 * files at runtime so an importmap entry like `"three" → "/_instatic/runtime/cache/
 * <hash>/three/build/three.module.js"` resolves to a real asset.
 *
 * URL shape
 * ─────────
 *   /_instatic/runtime/cache/<24-char-hex-hash>/<package>/<path>
 *
 * where `<package>` can be either a bare package name (`three`) or a scoped
 * one (`@scope/name`). Path traversal is blocked: every resolved path must
 * stay inside the hash's `node_modules/` directory.
 *
 * Cache validity
 * ──────────────
 * Each cache dir has a `.instatic-install-complete` sentinel written after
 * `bun install` succeeds. We refuse to serve when the sentinel is missing —
 * a stale or partial install must complete before responses go out.
 *
 * Headers
 * ───────
 * Content-addressed by lock hash, so files are immutable once written. A fresh
 * lock produces a fresh hash → fresh URLs; CDN caches and the browser cache
 * can keep responses indefinitely.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { nodeModulesDirForHash, sentinelPathForHash } from './dependencyCache'

const RUNTIME_PACKAGE_PREFIX = '/_instatic/runtime/cache/'
const HASH_PATTERN = /^[0-9a-f]{24}$/

function contentTypeForPath(path: string): string {
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.ts')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.map')) return 'application/json; charset=utf-8'
  if (path.endsWith('.wasm')) return 'application/wasm'
  return 'application/octet-stream'
}

export function isRuntimePackagePath(pathname: string): boolean {
  return pathname.startsWith(RUNTIME_PACKAGE_PREFIX)
}

/**
 * Resolve `/_instatic/runtime/cache/<hash>/<...>` to an absolute filesystem path
 * inside the cache. Returns `null` for any malformed URL — caller should
 * 404 in that case.
 *
 * Splits on the FIRST slash after the hash so scoped packages survive: the
 * remainder is appended verbatim under `node_modules/`.
 */
function resolveCacheFilePath(pathname: string): { hash: string; absPath: string } | null {
  const suffix = pathname.slice(RUNTIME_PACKAGE_PREFIX.length)
  const firstSlash = suffix.indexOf('/')
  if (firstSlash <= 0) return null

  const hash = suffix.slice(0, firstSlash)
  const subPath = suffix.slice(firstSlash + 1)
  if (!HASH_PATTERN.test(hash)) return null
  // Reject any traversal segments BEFORE `resolvePath` collapses them — a
  // sneaky `..` past the package root would otherwise be silently rewritten.
  if (subPath.includes('..') || subPath.includes('\0')) return null
  if (subPath.length === 0) return null

  const nodeModulesDir = nodeModulesDirForHash(hash)
  const absPath = resolvePath(nodeModulesDir, subPath)

  // Final containment check — the resolved path must live inside
  // node_modules/. Any escape attempt returns null.
  const rel = relative(nodeModulesDir, absPath)
  if (rel.startsWith('..') || isAbsolute(rel)) return null

  return { hash, absPath }
}

export async function tryServeRuntimePackage(req: Request, pathname: string): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null
  if (!isRuntimePackagePath(pathname)) return null

  const resolved = resolveCacheFilePath(pathname)
  if (!resolved) return new Response('not found', { status: 404 })

  // Refuse to serve from an in-progress / abandoned install. The sentinel is
  // written atomically *after* `bun install` succeeds (see dependencyCache.ts).
  if (!existsSync(sentinelPathForHash(resolved.hash))) {
    return new Response('runtime dependency cache not ready', { status: 404 })
  }

  const file = Bun.file(resolved.absPath)
  if (!(await file.exists())) return new Response('not found', { status: 404 })

  return new Response(req.method === 'HEAD' ? null : file.stream(), {
    headers: {
      'content-type': contentTypeForPath(resolved.absPath),
      'content-length': String(file.size),
      // Content-addressed by lock hash — a different lock yields different
      // URLs, so we can promise immutability.
      'cache-control': 'public, max-age=31536000, immutable',
      // The editor's iframe sandbox uses `sandbox="allow-scripts"` without
      // `allow-same-origin`, which puts it in an opaque origin. Module
      // fetches from there are cross-origin to the host, so CORS allowlist
      // is required. Published pages are same-origin and don't strictly
      // need the header, but emitting it uniformly keeps the asset
      // cacheable across origins.
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
    },
  })
}
