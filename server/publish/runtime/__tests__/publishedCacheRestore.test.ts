/**
 * A published page keeps pointing at `/_instatic/runtime/cache/<hash>/...`
 * for as long as it is live. These tests lose the cache directory underneath
 * a live publish (what a recreated container or a cleaned folder does) and
 * check that the package URL answers again without a republish.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSiteRuntimeConfig, type SiteDependencyLock } from '@core/site-runtime'
import { createTestDb, type TestDb } from '../../../../src/__tests__/helpers/createTestDb'
import { makePage, makeSite } from '../../../../src/__tests__/fixtures'
import { MAIN_SCOPE } from '../../../branches/scope'
import { createDataRow } from '../../../repositories/data/rows/mutations'
import { persistSitePublish } from '../../../repositories/publish'
import { handleServerRequest } from '../../../router'
import {
  ensureRuntimeDependencyCache,
  runtimeDependencyLockHash,
  type RuntimeInstallRunner,
} from '../dependencyCache'
import { tryServeRuntimePackage } from '../packageServer'
import { restorePublishedRuntimeCache } from '../publishedCacheRestore'

function lockFor(version: string): SiteDependencyLock {
  return {
    version: 1,
    updatedAt: 0,
    packages: {
      three: { name: 'three', requested: version, version, resolvedAt: 0 },
    },
  }
}

function packageUrl(lock: SiteDependencyLock): string {
  return `/_instatic/runtime/cache/${runtimeDependencyLockHash(lock)}/three/build/three.module.js`
}

let installs = 0
const fakeInstall: RuntimeInstallRunner = async (_command, options) => {
  installs += 1
  const pkgRoot = join(options.cwd, 'node_modules', 'three')
  await mkdir(join(pkgRoot, 'build'), { recursive: true })
  await writeFile(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'three' }))
  await writeFile(join(pkgRoot, 'build', 'three.module.js'), 'export const three = 1\n')
}

/** Publish `pageId` with `lock`, the way `publishSite` records it. */
async function publishWithLock(
  testDb: TestDb,
  pageId: string,
  lock: SiteDependencyLock,
  versionNumber = 1,
): Promise<void> {
  const site = makeSite({
    pages: [makePage({ id: pageId })],
    runtime: { ...normalizeSiteRuntimeConfig(undefined), dependencyLock: lock },
  })
  await persistSitePublish(testDb.db, {
    siteSnapshotId: `snap-${pageId}-${runtimeDependencyLockHash(lock)}`,
    site,
    serializedImportmap: {
      body: JSON.stringify({ imports: { three: packageUrl(lock) } }),
      sha256: 'unused',
    },
    pages: [{
      pageId,
      title: pageId,
      slug: pageId,
      versionId: `${pageId}-${runtimeDependencyLockHash(lock)}`,
      versionNumber,
      runtimeAssets: null,
      runtimeFiles: [],
    }],
    publishedByUserId: null,
  })
}

function serve(testDb: TestDb, url: string): Promise<Response | null> {
  return tryServeRuntimePackage(new Request(`http://localhost${url}`), url, (hash) =>
    restorePublishedRuntimeCache(testDb.db, hash, { runInstall: fakeInstall }),
  )
}

let cacheRoot: string
let savedEnv: string | undefined
let testDb: TestDb

beforeAll(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'instatic-cache-restore-'))
  savedEnv = process.env.RUNTIME_CACHE_DIR
  process.env.RUNTIME_CACHE_DIR = cacheRoot
})

afterAll(async () => {
  if (savedEnv === undefined) delete process.env.RUNTIME_CACHE_DIR
  else process.env.RUNTIME_CACHE_DIR = savedEnv
  await rm(cacheRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  installs = 0
  testDb = await createTestDb()
  await createDataRow(testDb.db, MAIN_SCOPE, { id: 'home', tableId: 'pages', cells: { title: 'home' }, slug: 'home' })
})

afterEach(async () => {
  await testDb.cleanup()
  await rm(cacheRoot, { recursive: true, force: true })
})

describe('a published runtime package after its cache is lost', () => {
  it('is served again once the whole cache directory is gone', async () => {
    const lock = lockFor('0.160.0')
    await ensureRuntimeDependencyCache(lock, { runInstall: fakeInstall })
    await publishWithLock(testDb, 'home', lock)
    expect((await serve(testDb, packageUrl(lock)))?.status).toBe(200)
    expect(installs).toBe(1)

    await rm(cacheRoot, { recursive: true, force: true })

    expect((await serve(testDb, packageUrl(lock)))?.status).toBe(200)
    expect(installs).toBe(2)
  })

  it('is served again when the files were removed but the marker survived', async () => {
    const lock = lockFor('0.161.0')
    const cache = await ensureRuntimeDependencyCache(lock, { runInstall: fakeInstall })
    await publishWithLock(testDb, 'home', lock)

    await rm(join(cache.nodeModulesDir, 'three'), { recursive: true, force: true })

    expect((await serve(testDb, packageUrl(lock)))?.status).toBe(200)
    expect(installs).toBe(2)
  })

  it('does not install for a hash no live publish uses', async () => {
    const published = lockFor('0.162.0')
    await publishWithLock(testDb, 'home', published)

    const neverPublished = lockFor('0.163.0')
    expect((await serve(testDb, packageUrl(neverPublished)))?.status).toBe(404)
    expect(installs).toBe(0)

    // Through the real router too: an unknown hash is a plain 404.
    const res = await handleServerRequest(
      new Request(`http://localhost${packageUrl(neverPublished)}`),
      { db: testDb.db },
    )
    expect(res.status).toBe(404)
  })

  it('does not install for a lock whose publish was replaced', async () => {
    const first = lockFor('0.164.0')
    const second = lockFor('0.165.0')
    await publishWithLock(testDb, 'home', first)
    await publishWithLock(testDb, 'home', second, 2)

    expect((await serve(testDb, packageUrl(first)))?.status).toBe(404)
    expect(installs).toBe(0)
    expect((await serve(testDb, packageUrl(second)))?.status).toBe(200)
    expect(installs).toBe(1)
  })

  it('asks the database once for repeated misses on the same hash', async () => {
    const lock = lockFor('0.167.0')
    await ensureRuntimeDependencyCache(lock, { runInstall: fakeInstall })
    await publishWithLock(testDb, 'home', lock)
    let queries = 0
    const counting = new Proxy(testDb.db, {
      apply(target, thisArg, args) {
        queries += 1
        return Reflect.apply(target, thisArg, args)
      },
    })
    const counted = { ...testDb, db: counting }

    // A wrong path under a live hash, and a hash nothing published.
    const wrongPath = `/_instatic/runtime/cache/${runtimeDependencyLockHash(lock)}/three/nope.js`
    const unknown = packageUrl(lockFor('0.168.0'))
    for (const url of [wrongPath, wrongPath, wrongPath, unknown, unknown, unknown]) {
      expect((await serve(counted, url))?.status).toBe(404)
    }
    expect(queries).toBe(2)
    expect(installs).toBe(1)
  })

  it('remembers a failed reinstall instead of retrying on every request', async () => {
    const lock = lockFor('0.166.0')
    await publishWithLock(testDb, 'home', lock)
    const hash = runtimeDependencyLockHash(lock)
    let attempts = 0
    const failingInstall: RuntimeInstallRunner = async () => {
      attempts += 1
      throw new Error('registry unreachable')
    }
    let clock = 1_000_000
    const options = { runInstall: failingInstall, now: () => clock }
    const originalError = console.error
    console.error = () => {}
    try {
      expect(await restorePublishedRuntimeCache(testDb.db, hash, options)).toBe(false)
      expect(await restorePublishedRuntimeCache(testDb.db, hash, options)).toBe(false)
      expect(attempts).toBe(1)

      clock += 31_000
      expect(await restorePublishedRuntimeCache(testDb.db, hash, options)).toBe(false)
      expect(attempts).toBe(2)
    } finally {
      console.error = originalError
    }

    // The registry is back: the next attempt after the wait succeeds.
    clock += 31_000
    expect(
      await restorePublishedRuntimeCache(testDb.db, hash, { runInstall: fakeInstall, now: () => clock }),
    ).toBe(true)
  })
})
