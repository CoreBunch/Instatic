import { describe, expect, it } from 'bun:test'
import { DEFAULT_SCRIPT_RUNTIME_CONFIG } from '@core/site-runtime'
import {
  createDefaultSiteExplorerOrganization,
  DEFAULT_SITE_SETTINGS,
} from '@core/page-tree'
import type { Page, SiteDocument } from '@core/page-tree'
import { buildSiteRuntimeScripts } from '../publish/runtime/bundleScripts'

function makeRuntimePage(): Page {
  return {
    id: 'page-1',
    slug: 'index',
    title: 'Index',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.body',
        props: {},
        children: [],
        breakpointOverrides: {},
        classIds: [],
        locked: false,
        hidden: false,
      },
    },
  }
}

function makeRuntimeSite(page: Page): SiteDocument {
  return {
    id: 'site-1',
    name: 'Runtime Test Site',
    pages: [page],
    visualComponents: [],
    layouts: [],
    breakpoints: [
      { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
    ],
    settings: structuredClone(DEFAULT_SITE_SETTINGS),
    styleRules: {},
    files: [
      {
        id: 'legacy-vendor',
        path: 'assets/js/legacy-vendor.js',
        type: 'script',
        content: 'typeof exports === "object" ? require("jquery") : window.jQuery;',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    explorer: createDefaultSiteExplorerOrganization(),
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: {
      dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
      styles: {},
      scripts: {
        'legacy-vendor': {
          ...DEFAULT_SCRIPT_RUNTIME_CONFIG,
          format: 'classic',
        },
      },
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('buildSiteRuntimeScripts', () => {
  it('emits classic scripts raw without resolving UMD require branches', async () => {
    const page = makeRuntimePage()
    const site = makeRuntimeSite(page)

    const result = await buildSiteRuntimeScripts({
      site,
      page,
      target: 'publish',
      assetBasePath: '/_instatic/assets/version-1/',
    })

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(result.files).toHaveLength(1)
    expect(result.files[0].content).toContain('require("jquery")')
    expect(result.runtimeAssets.scripts).toHaveLength(1)
    expect(result.runtimeAssets.scripts[0].format).toBe('classic')
    expect(result.runtimeAssets.scripts[0].src).toContain('/_instatic/assets/version-1/classic/')
  })
})
