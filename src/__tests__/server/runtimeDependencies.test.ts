import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { resolveSiteDependencyLock } from '../../../server/publish/runtime/dependencyResolver'
import {
  ensureRuntimeDependencyCache,
  runtimeDependencyLockHash,
} from '../../../server/publish/runtime/dependencyCache'
import type { SiteDependencyLock } from '@core/site-runtime'

function registryResponse(name: string) {
  return new Response(JSON.stringify({
    name,
    'dist-tags': { latest: '2.0.0' },
    versions: {
      '1.8.0': {
        dist: {
          tarball: `https://registry.example/${name}/-/pkg-1.8.0.tgz`,
          integrity: 'sha512-1',
        },
      },
      '1.9.3': {
        dist: {
          tarball: `https://registry.example/${name}/-/pkg-1.9.3.tgz`,
          integrity: 'sha512-2',
        },
      },
      '2.0.0': {
        dist: {
          tarball: `https://registry.example/${name}/-/pkg-2.0.0.tgz`,
          integrity: 'sha512-3',
        },
      },
    },
  }))
}

describe('runtime dependency resolution', () => {
  it('resolves site dependencies to exact locked versions from npm metadata', async () => {
    const seenUrls: string[] = []
    const lock = await resolveSiteDependencyLock(
      {
        dependencies: {
          'canvas-confetti': '^1.0.0',
        },
        devDependencies: {
          vite: '^7.0.0',
        },
      },
      {
        fetch: async (url) => {
          seenUrls.push(String(url))
          return registryResponse('canvas-confetti')
        },
        now: () => 123,
      },
    )

    expect(seenUrls).toEqual(['https://registry.npmjs.org/canvas-confetti'])
    expect(lock).toEqual({
      version: 1,
      updatedAt: 123,
      packages: {
        'canvas-confetti': {
          name: 'canvas-confetti',
          requested: '^1.0.0',
          version: '1.9.3',
          integrity: 'sha512-2',
          tarballUrl: 'https://registry.example/canvas-confetti/-/pkg-1.9.3.tgz',
          resolvedAt: 123,
        },
      },
    })
  })

  it('uses a stable lock hash independent of package object order', () => {
    const a: SiteDependencyLock = {
      version: 1,
      updatedAt: 100,
      packages: {
        b: { name: 'b', requested: '^1', version: '1.0.0', resolvedAt: 100 },
        a: { name: 'a', requested: '^1', version: '1.0.0', resolvedAt: 100 },
      },
    }
    const b: SiteDependencyLock = {
      version: 1,
      updatedAt: 200,
      packages: {
        a: { name: 'a', requested: '^2', version: '1.0.0', resolvedAt: 200 },
        b: { name: 'b', requested: '^2', version: '1.0.0', resolvedAt: 200 },
      },
    }

    expect(runtimeDependencyLockHash(a)).toBe(runtimeDependencyLockHash(b))
  })

  it('creates an isolated Bun install workspace with lifecycle scripts disabled', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'instatic-runtime-cache-test-'))
    const calls: Array<{ command: string[]; cwd: string }> = []
    const lock: SiteDependencyLock = {
      version: 1,
      updatedAt: 100,
      packages: {
        'canvas-confetti': {
          name: 'canvas-confetti',
          requested: '^1.9.3',
          version: '1.9.3',
          resolvedAt: 100,
        },
      },
    }

    try {
      const cache = await ensureRuntimeDependencyCache(lock, {
        cacheRoot,
        runInstall: async (command, options) => {
          calls.push({ command, cwd: options.cwd })
          await mkdir(join(options.cwd, 'node_modules'), { recursive: true })
          await writeFile(join(options.cwd, 'bun.lock'), '', 'utf8')
        },
      })
      const generatedPackage = JSON.parse(await readFile(join(cache.workspaceDir, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
      }

      expect(cache.nodeModulesDir).toBe(join(cache.workspaceDir, 'node_modules'))
      expect(generatedPackage.dependencies).toEqual({ 'canvas-confetti': '1.9.3' })
      expect(calls).toHaveLength(1)
      expect(calls[0].command).toEqual([process.execPath, 'install', '--ignore-scripts'])
      // Install runs in a temp sibling dir, then the dir is atomically renamed
      // into its final hash slot. The cwd passed to runInstall must therefore
      // NOT be the final workspaceDir.
      expect(calls[0].cwd).not.toBe(cache.workspaceDir)
      expect(calls[0].cwd.startsWith(join(cacheRoot, 'deps', `.tmp-${cache.hash}-`))).toBe(true)
      // Sentinel marker proves the install completed; it must be present at
      // the final cache path.
      const sentinel = JSON.parse(
        await readFile(join(cache.workspaceDir, '.instatic-install-complete'), 'utf8'),
      ) as { hash: string; packageCount: number }
      expect(sentinel.hash).toBe(cache.hash)
      expect(sentinel.packageCount).toBe(1)
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it('skips reinstall when a sentinel-marked cache already exists', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'instatic-runtime-cache-test-'))
    const lock: SiteDependencyLock = {
      version: 1,
      updatedAt: 100,
      packages: {
        'canvas-confetti': {
          name: 'canvas-confetti',
          requested: '^1.9.3',
          version: '1.9.3',
          resolvedAt: 100,
        },
      },
    }

    try {
      let installCount = 0
      const runInstall = async (_command: string[], options: { cwd: string }) => {
        installCount += 1
        await mkdir(join(options.cwd, 'node_modules', 'canvas-confetti'), { recursive: true })
        await writeFile(join(options.cwd, 'node_modules', 'canvas-confetti', 'package.json'), '{}', 'utf8')
      }

      const first = await ensureRuntimeDependencyCache(lock, { cacheRoot, runInstall })
      const second = await ensureRuntimeDependencyCache(lock, { cacheRoot, runInstall })

      expect(installCount).toBe(1)
      expect(second.workspaceDir).toBe(first.workspaceDir)
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it('reinstalls when the sentinel survived but a locked package was reaped from node_modules', async () => {
    // The default cache root is the OS temp dir. Temp cleaners delete package
    // files by age (packages Bun clones from its global cache keep old
    // mtimes) and leave the directories and the sentinel behind — the exact
    // state that made publish validation report `Could not resolve
    // "canvas-confetti"` for a declared, locked dependency.
    const cacheRoot = await mkdtemp(join(tmpdir(), 'instatic-runtime-cache-test-'))
    const lock: SiteDependencyLock = {
      version: 1,
      updatedAt: 100,
      packages: {
        'canvas-confetti': {
          name: 'canvas-confetti',
          requested: '^1.9.3',
          version: '1.9.3',
          resolvedAt: 100,
        },
        swup: { name: 'swup', requested: '^4', version: '4.9.2', resolvedAt: 100 },
      },
    }
    const installAll = async (_command: string[], options: { cwd: string }) => {
      for (const name of ['canvas-confetti', 'swup']) {
        await mkdir(join(options.cwd, 'node_modules', name, 'dist'), { recursive: true })
        await writeFile(join(options.cwd, 'node_modules', name, 'package.json'), '{}', 'utf8')
        await writeFile(join(options.cwd, 'node_modules', name, 'dist', 'index.js'), '', 'utf8')
      }
    }

    try {
      const first = await ensureRuntimeDependencyCache(lock, { cacheRoot, runInstall: installAll })
      // Reap one package's files the way a temp cleaner does: files go,
      // empty directories and the sentinel stay.
      const reaped = join(first.nodeModulesDir, 'canvas-confetti')
      await rm(join(reaped, 'package.json'), { force: true })
      await rm(join(reaped, 'dist', 'index.js'), { force: true })
      expect(await readFile(join(first.workspaceDir, '.instatic-install-complete'), 'utf8')).toContain(first.hash)

      let installCount = 0
      const healed = await ensureRuntimeDependencyCache(lock, {
        cacheRoot,
        runInstall: async (command, options) => {
          installCount += 1
          await installAll(command, options)
        },
      })

      expect(installCount).toBe(1)
      expect(healed.workspaceDir).toBe(first.workspaceDir)
      expect(await readFile(join(healed.nodeModulesDir, 'canvas-confetti', 'package.json'), 'utf8')).toBe('{}')

      // Intact again: no third install.
      await ensureRuntimeDependencyCache(lock, {
        cacheRoot,
        runInstall: async () => { installCount += 1 },
      })
      expect(installCount).toBe(1)
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it('self-heals when a stale cache is missing the sentinel (partial install)', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'instatic-runtime-cache-test-'))
    const lock: SiteDependencyLock = {
      version: 1,
      updatedAt: 100,
      packages: {
        'canvas-confetti': {
          name: 'canvas-confetti',
          requested: '^1.9.3',
          version: '1.9.3',
          resolvedAt: 100,
        },
      },
    }

    try {
      // Simulate a previous interrupted install: a workspaceDir exists at the
      // hash slot but is missing the sentinel and only has a partial
      // node_modules tree. ensureRuntimeDependencyCache must NOT trust the
      // bare directory and must re-install.
      const hash = (await ensureRuntimeDependencyCache(lock, {
        cacheRoot,
        runInstall: async (_command, options) => {
          await mkdir(join(options.cwd, 'node_modules'), { recursive: true })
        },
      })).hash
      const workspaceDir = join(cacheRoot, 'deps', hash)
      await rm(join(workspaceDir, '.instatic-install-complete'), { force: true })
      await rm(join(workspaceDir, 'node_modules'), { recursive: true, force: true })
      await mkdir(join(workspaceDir, 'node_modules', 'canvas-confetti'), { recursive: true })

      let installCount = 0
      const cache = await ensureRuntimeDependencyCache(lock, {
        cacheRoot,
        runInstall: async (_command, options) => {
          installCount += 1
          await mkdir(join(options.cwd, 'node_modules', 'canvas-confetti'), { recursive: true })
          await writeFile(join(options.cwd, 'node_modules', 'canvas-confetti', 'package.json'), '{}', 'utf8')
        },
      })

      expect(installCount).toBe(1)
      expect(cache.workspaceDir).toBe(workspaceDir)
      // After self-heal, the sentinel exists and the package files written by
      // the new install are visible at the final path.
      expect(
        JSON.parse(await readFile(join(workspaceDir, '.instatic-install-complete'), 'utf8')),
      ).toMatchObject({ hash })
      expect(
        await readFile(join(workspaceDir, 'node_modules', 'canvas-confetti', 'package.json'), 'utf8'),
      ).toBe('{}')
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it('rejects locks that exceed the package-count cap', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'instatic-runtime-cache-test-'))
    try {
      const packages: SiteDependencyLock['packages'] = {}
      for (let i = 0; i < 10; i += 1) {
        const name = `pkg-${i}`
        packages[name] = { name, requested: '*', version: '1.0.0', resolvedAt: 1 }
      }
      const lock: SiteDependencyLock = { version: 1, updatedAt: 1, packages }

      let installs = 0
      await expect(
        ensureRuntimeDependencyCache(lock, {
          cacheRoot,
          maxPackages: 5,
          runInstall: async () => {
            installs += 1
          },
        }),
      ).rejects.toThrow(/too many runtime packages/i)
      // The cap must be enforced BEFORE the install is invoked — no install
      // command should ever fire for an oversized lock.
      expect(installs).toBe(0)
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it('aborts the install when the timeout elapses before exit', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'instatic-runtime-cache-test-'))
    const lock: SiteDependencyLock = {
      version: 1,
      updatedAt: 1,
      packages: {
        'canvas-confetti': {
          name: 'canvas-confetti',
          requested: '^1.9.3',
          version: '1.9.3',
          resolvedAt: 1,
        },
      },
    }

    try {
      await expect(
        ensureRuntimeDependencyCache(lock, {
          cacheRoot,
          installTimeoutMs: 30,
          runInstall: async (_command, options) => {
            // Imitate a stuck install that never returns until aborted.
            await new Promise<void>((resolve, reject) => {
              const settle = () => {
                clearTimeout(stallTimer)
                reject(new Error('aborted'))
              }
              const stallTimer = setTimeout(resolve, 5_000)
              if (options.signal?.aborted) {
                settle()
                return
              }
              options.signal?.addEventListener('abort', settle, { once: true })
            })
          },
        }),
      ).rejects.toThrow()
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it('deduplicates concurrent installs of the same lock hash', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'instatic-runtime-cache-test-'))
    const lock: SiteDependencyLock = {
      version: 1,
      updatedAt: 1,
      packages: {
        'canvas-confetti': {
          name: 'canvas-confetti',
          requested: '^1.9.3',
          version: '1.9.3',
          resolvedAt: 1,
        },
      },
    }

    try {
      let installCount = 0
      const runInstall = async (_command: string[], options: { cwd: string }) => {
        installCount += 1
        // A small delay ensures both calls are in flight at the same time so
        // the dedupe map actually has something to share.
        await new Promise((resolve) => setTimeout(resolve, 25))
        await mkdir(join(options.cwd, 'node_modules'), { recursive: true })
      }

      const [a, b] = await Promise.all([
        ensureRuntimeDependencyCache(lock, { cacheRoot, runInstall }),
        ensureRuntimeDependencyCache(lock, { cacheRoot, runInstall }),
      ])

      expect(installCount).toBe(1)
      expect(a.workspaceDir).toBe(b.workspaceDir)
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })
})
