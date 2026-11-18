import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { DbClient, DbResult } from '../../../db'
import { readRuntimeCacheDir } from '../../../config'
import { handleServerRequest } from '../../../router'
import type { SiteDependencyLock } from '@core/site-runtime'
import {
  cacheRootDir,
  ensureRuntimeDependencyCache,
  nodeModulesDirForHash,
  runtimeDependencyLockHash,
  sentinelPathForHash,
  workspaceDirForHash,
  type RuntimeInstallRunner,
} from '../dependencyCache'
import { buildRuntimePackageImportmapFromLock } from '../packageImportmap'
import { tryServeRuntimePackage } from '../packageServer'

const LOCK: SiteDependencyLock = {
  version: 1,
  updatedAt: 0,
  packages: {
    three: { name: 'three', requested: '^0.160.0', version: '0.160.0', resolvedAt: 0 },
  },
}

// Fake install — writes a minimal `three` package into the workspace's
// node_modules so the readers have something real to resolve.
const fakeInstall: RuntimeInstallRunner = async (_command, options) => {
  const pkgRoot = join(options.cwd, 'node_modules', 'three')
  await mkdir(join(pkgRoot, 'build'), { recursive: true })
  await writeFile(
    join(pkgRoot, 'package.json'),
    JSON.stringify({ name: 'three', module: './build/three.module.js' }),
  )
  await writeFile(join(pkgRoot, 'build', 'three.module.js'), 'export const three = 1\n')
}

function createThrowingDb(): { db: DbClient; wasQueried: () => boolean } {
  let queried = false
  const failTagged = async <Row = Record<string, unknown>>(
    _strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<DbResult<Row>> => {
    queried = true
    throw new Error('unexpected database query while serving runtime cache package')
  }
  const failUnsafe = async <Row = Record<string, unknown>>(
    _sql: string,
    _params?: unknown[],
  ): Promise<DbResult<Row>> => {
    queried = true
    throw new Error('unexpected unsafe database query while serving runtime cache package')
  }
  const db = failTagged as DbClient
  db.unsafe = failUnsafe
  db.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> => cb(db)
  Object.defineProperty(db, 'dialect', { value: 'sqlite' satisfies DbClient['dialect'] })
  return { db, wasQueried: () => queried }
}

/** These tests never lose the cache, so nothing is ever restored. */
const noRestore = async () => false

let cacheRoot: string
let savedEnv: string | undefined

beforeAll(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'instatic-cache-layout-'))
  savedEnv = process.env.RUNTIME_CACHE_DIR
  // Point the env-based readers (packageServer) at the same root the writer uses.
  process.env.RUNTIME_CACHE_DIR = cacheRoot
})

afterAll(async () => {
  if (savedEnv === undefined) delete process.env.RUNTIME_CACHE_DIR
  else process.env.RUNTIME_CACHE_DIR = savedEnv
  await rm(cacheRoot, { recursive: true, force: true })
})

describe('runtime cache layout — reader/writer agreement', () => {
  it('exposes a single env-driven cache root', () => {
    expect(cacheRootDir()).toBe(cacheRoot)
  })

  it('defaults to a persistent directory, never the OS temp folder', () => {
    const previous = process.env.RUNTIME_CACHE_DIR
    delete process.env.RUNTIME_CACHE_DIR
    try {
      expect(cacheRootDir()).toBe(readRuntimeCacheDir(process.env))
      expect(cacheRootDir().startsWith(resolve(tmpdir()))).toBe(false)
    } finally {
      process.env.RUNTIME_CACHE_DIR = previous
    }
  })

  it('normalizes a relative env-driven cache root before exposing cache paths', () => {
    const previous = process.env.RUNTIME_CACHE_DIR
    process.env.RUNTIME_CACHE_DIR = './.tmp/relative-runtime-cache'
    try {
      const root = cacheRootDir()
      expect(root).toBe(resolve('./.tmp/relative-runtime-cache'))
      expect(isAbsolute(root)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_CACHE_DIR
      else process.env.RUNTIME_CACHE_DIR = previous
    }
  })

  it('writer materializes the workspace at the layout the accessors describe', async () => {
    const hash = runtimeDependencyLockHash(LOCK)
    const cache = await ensureRuntimeDependencyCache(LOCK, { runInstall: fakeInstall })

    // The writer's returned struct must equal the accessor-derived paths.
    expect(cache.hash).toBe(hash)
    expect(cache.workspaceDir).toBe(workspaceDirForHash(hash))
    expect(cache.nodeModulesDir).toBe(nodeModulesDirForHash(hash))

    // And the sentinel landed exactly where the readers look for it.
    expect(existsSync(sentinelPathForHash(hash))).toBe(true)
  })

  it('packageImportmap resolves through the same paths the writer wrote', async () => {
    const hash = runtimeDependencyLockHash(LOCK)
    const result = await buildRuntimePackageImportmapFromLock(LOCK)
    expect(result).not.toBeNull()
    expect(result?.lockHash).toBe(hash)
    expect(result?.importmap.imports.three).toBe(
      `/_instatic/runtime/cache/${hash}/three/build/three.module.js`,
    )
  })

  it('packageServer serves the file the writer installed at the shared layout', async () => {
    const hash = runtimeDependencyLockHash(LOCK)
    // The exact path packageImportmap resolved — packageServer must find a real
    // file there, proving reader and writer agree on the on-disk layout.
    // (Body bytes aren't asserted: the test preload swaps in happy-dom's
    // `Response`, which can't read a BunFile body. Status 200 means the path
    // resolved to a file the writer actually installed.)
    const url = `/_instatic/runtime/cache/${hash}/three/build/three.module.js`
    const res = await tryServeRuntimePackage(new Request(`http://localhost${url}`), url, noRestore)
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('text/javascript; charset=utf-8')

    // Negative control: a path the writer never installed must 404, confirming
    // the server resolves inside the writer's node_modules and nowhere else.
    const missingUrl = `/_instatic/runtime/cache/${hash}/three/build/does-not-exist.js`
    const missing = await tryServeRuntimePackage(new Request(`http://localhost${missingUrl}`), missingUrl, noRestore)
    expect(missing?.status).toBe(404)
  })

  it('router owns runtime cache package URLs before public routing or database fallback', async () => {
    const hash = runtimeDependencyLockHash(LOCK)
    await ensureRuntimeDependencyCache(LOCK, { runInstall: fakeInstall })
    const { db, wasQueried } = createThrowingDb()

    const url = `/_instatic/runtime/cache/${hash}/three/build/three.module.js`
    const res = await handleServerRequest(new Request(`http://localhost${url}`), { db })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(wasQueried()).toBe(false)
  })

  it('router keeps malformed runtime cache package URLs inside the exclusive namespace', async () => {
    const { db, wasQueried } = createThrowingDb()

    const res = await handleServerRequest(
      new Request('http://localhost/_instatic/runtime/cache/not-a-24-hex/three/build/three.module.js'),
      { db },
    )
    expect(res.status).toBe(404)
    expect(wasQueried()).toBe(false)
  })

  it('packageServer rejects malformed hashes and traversal-shaped package paths', async () => {
    const malformedUrls = [
      '/_instatic/runtime/cache/not-a-24-hex/three/build/three.module.js',
      '/_instatic/runtime/cache/aaaaaaaaaaaaaaaaaaaaaaaa/../secret.js',
      '/_instatic/runtime/cache/aaaaaaaaaaaaaaaaaaaaaaaa/three/../package.json',
      '/_instatic/runtime/cache/aaaaaaaaaaaaaaaaaaaaaaaa/',
    ]

    for (const url of malformedUrls) {
      const res = await tryServeRuntimePackage(new Request(`http://localhost${url}`), url, noRestore)
      expect(res?.status).toBe(404)
    }
  })
})
