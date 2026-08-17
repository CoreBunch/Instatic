import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { SiteDocument } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { buildRuntimePreviewDocument } from '../../../server/publish/runtime/previewRuntime'
import { buildSiteRuntimeScripts } from '../../../server/publish/runtime/bundleScripts'
import { makeModule, makePage, makeRegistry, makeSite } from '../publisher/helpers'

const page = makePage({
  root: { moduleId: 'base.body', props: {}, children: [] },
})

const registry = makeRegistry({
  'base.body': makeModule('base.body', {
    canHaveChildren: true,
    render: (_props, children) => ({ html: `<main>${children.join('')}</main>` }),
  }),
})

function runtimeSite(overrides: Partial<SiteDocument> = {}): SiteDocument {
  return makeSite({
    pages: [page],
    files: [
      {
        id: 'entry',
        path: 'src/scripts/entry.ts',
        type: 'script',
        content: `
          import { message } from './message'
          window.__instaticRuntimeMessage = message
        `,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'message',
        path: 'src/scripts/message.ts',
        type: 'script',
        content: `export const message = 'hello-runtime'`,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: normalizeSiteRuntimeConfig({
      scripts: {
        entry: {
          placement: 'head',
          priority: 10,
        },
        message: {
          enabled: false,
        },
      },
    }),
    ...overrides,
  })
}

describe('site runtime build', () => {
  it('bundles enabled site script entrypoints and returns self-hosted runtime assets', async () => {
    const result = await buildSiteRuntimeScripts({
      site: runtimeSite(),
      page,
      target: 'publish',
      assetBasePath: '/_instatic/assets/runtime/',
    })

    expect(result.diagnostics).toEqual([])
    expect(result.files.length).toBeGreaterThan(0)
    expect(result.runtimeAssets.scripts).toHaveLength(1)
    expect(result.runtimeAssets.scripts[0]).toMatchObject({
      fileId: 'entry',
      placement: 'head',
      priority: 10,
    })
    expect(result.runtimeAssets.scripts[0].src).toStartWith('/_instatic/assets/runtime/')
    const entryAsset = result.files.find((file) => file.publicPath === result.runtimeAssets.scripts[0].src)
    expect(entryAsset?.content).toContain('hello-runtime')
  })

  it('returns diagnostics and skips bundling when runtime imports undeclared packages', async () => {
    const site = runtimeSite({
      files: [
        {
          id: 'entry',
          path: 'src/scripts/entry.ts',
          type: 'script',
          content: `import confetti from 'canvas-confetti'; confetti()`,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    const result = await buildSiteRuntimeScripts({
      site,
      page,
      target: 'publish',
      assetBasePath: '/_instatic/assets/runtime/',
    })

    expect(result.files).toEqual([])
    expect(result.runtimeAssets.scripts).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'runtime-dependency-missing',
        packageName: 'canvas-confetti',
        severity: 'error',
      }),
    ])
  })

  it('maps syntax diagnostics back to the authored script and source location', async () => {
    const site = runtimeSite({
      files: [
        {
          id: 'broken-script',
          path: 'src/scripts/broken.ts',
          type: 'script',
          content: `const value from 'broken'`,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      runtime: normalizeSiteRuntimeConfig({
        scripts: {
          'broken-script': {
            placement: 'head',
            priority: 10,
          },
        },
      }),
    })

    const result = await buildSiteRuntimeScripts({
      site,
      page,
      target: 'publish',
      assetBasePath: '/_instatic/assets/runtime/',
    })

    expect(result.files).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'runtime-bundle-error',
        severity: 'error',
        message: 'Expected ";" but found "from"',
        fileId: 'broken-script',
        path: 'src/scripts/broken.ts',
        line: 1,
        column: expect.any(Number),
      }),
    ])
  })

  it('validates enabled scripts even when their scope excludes the current page', async () => {
    const site = runtimeSite({
      files: [{
        id: 'other-page-script',
        path: 'src/scripts/other-page.ts',
        type: 'script',
        content: `const value from 'broken'`,
        createdAt: 1,
        updatedAt: 1,
      }],
      runtime: normalizeSiteRuntimeConfig({
        scripts: {
          'other-page-script': {
            scope: { type: 'pages', pageIds: ['another-page'] },
          },
        },
      }),
    })

    const result = await buildSiteRuntimeScripts({
      site,
      target: 'publish',
      assetBasePath: '/_instatic/runtime-validation/',
      scriptSelection: 'all-enabled',
    })

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        fileId: 'other-page-script',
        path: 'src/scripts/other-page.ts',
        line: 1,
        severity: 'error',
      }),
    ])
  })

  it('syntax-checks classic scripts while preserving their raw published output', async () => {
    const site = runtimeSite({
      files: [{
        id: 'classic-script',
        path: 'src/scripts/classic.js',
        type: 'script',
        content: 'window.classic = ;',
        createdAt: 1,
        updatedAt: 1,
      }],
      runtime: normalizeSiteRuntimeConfig({
        scripts: {
          'classic-script': { format: 'classic' },
        },
      }),
    })

    const result = await buildSiteRuntimeScripts({
      site,
      page,
      target: 'publish',
      assetBasePath: '/_instatic/assets/runtime/',
    })

    expect(result.files).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        fileId: 'classic-script',
        path: 'src/scripts/classic.js',
        line: 1,
        severity: 'error',
      }),
    ])
  })

  it('reports classic and module syntax errors in the same validation pass', async () => {
    const site = runtimeSite({
      files: [
        {
          id: 'classic-script',
          path: 'src/scripts/classic.js',
          type: 'script',
          content: 'window.classic = ;',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'module-script',
          path: 'src/scripts/module.ts',
          type: 'script',
          content: `const value from 'broken'`,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      runtime: normalizeSiteRuntimeConfig({
        scripts: {
          'classic-script': { format: 'classic' },
          'module-script': { format: 'module' },
        },
      }),
    })

    const result = await buildSiteRuntimeScripts({
      site,
      target: 'publish',
      assetBasePath: '/_instatic/runtime-validation/',
      scriptSelection: 'all-enabled',
    })

    expect(result.files).toEqual([])
    expect(result.runtimeAssets.scripts).toEqual([])
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fileId: 'classic-script',
        path: 'src/scripts/classic.js',
        severity: 'error',
      }),
      expect.objectContaining({
        fileId: 'module-script',
        path: 'src/scripts/module.ts',
        severity: 'error',
      }),
    ]))
  })

  it('builds a preview document with the same runtime assets used by publish rendering', async () => {
    const result = await buildRuntimePreviewDocument({
      site: runtimeSite(),
      page,
      registry,
      assetBasePath: '/_instatic/preview/runtime/',
    })

    expect(result.diagnostics).toEqual([])
    expect(result.html).toContain("script-src 'self'")
    expect(result.html).toContain('data-instatic-runtime-script="entry"')
    expect(result.html).toContain('/_instatic/preview/runtime/')
  })

  it('resolves declared package imports from a dependency cache node_modules directory', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'instatic-runtime-node-modules-'))
    const nodeModulesDir = join(cacheRoot, 'node_modules')
    await mkdir(join(nodeModulesDir, 'fake-runtime-package'), { recursive: true })
    await writeFile(
      join(nodeModulesDir, 'fake-runtime-package', 'package.json'),
      JSON.stringify({ name: 'fake-runtime-package', version: '1.0.0', type: 'module', main: './index.js' }),
      'utf8',
    )
    await writeFile(
      join(nodeModulesDir, 'fake-runtime-package', 'index.js'),
      `export const packageMessage = 'from-cache-package'`,
      'utf8',
    )

    try {
      const site = runtimeSite({
        files: [
          {
            id: 'entry',
            path: 'src/scripts/entry.ts',
            type: 'script',
            content: `
              import { packageMessage } from 'fake-runtime-package'
              window.__instaticRuntimeMessage = packageMessage
            `,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        packageJson: {
          dependencies: { 'fake-runtime-package': '1.0.0' },
          devDependencies: {},
        },
      })

      const result = await buildSiteRuntimeScripts({
        site,
        page,
        target: 'publish',
        assetBasePath: '/_instatic/assets/runtime/',
        dependencyNodeModulesDir: nodeModulesDir,
      })

      expect(result.diagnostics).toEqual([])
      expect(result.files.some((file) => file.content.includes('from-cache-package'))).toBe(true)
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it('returns a timeout diagnostic instead of stalling when the bundle timeout fires', async () => {
    const result = await buildSiteRuntimeScripts({
      site: runtimeSite(),
      page,
      target: 'publish',
      assetBasePath: '/_instatic/assets/runtime/',
      // bundleTimeoutMs <= 0 short-circuits to a synchronous timeout error
      // before esbuild runs. This is deterministic — a real `setTimeout(0)`
      // race against esbuild's promise can be won by either side depending
      // on host speed.
      bundleTimeoutMs: 0,
    })

    expect(result.runtimeAssets.scripts).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime-bundle-error',
          severity: 'error',
          message: expect.stringMatching(/timed out/i),
        }),
      ]),
    )
  })
})
