import { beforeEach, describe, expect, it } from 'bun:test'
import { DEFAULT_SCRIPT_RUNTIME_CONFIG } from '@core/site-runtime'
import {
  createDefaultSiteExplorerOrganization,
  DEFAULT_SITE_SETTINGS,
} from '@core/page-tree'
import type { Page, SiteDocument, SiteFile } from '@core/page-tree'
import { buildPreviewRuntime } from '../publish/branchPreview'
import { readPreviewAsset, resetPreviewBuilds } from '../publish/branchPreviewAssets'

function makePage(): Page {
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

function scriptFile(id: string, path: string, content: string): SiteFile {
  return { id, path, type: 'script', content, createdAt: 1, updatedAt: 1 }
}

function makeSite(page: Page, files: SiteFile[], scripts: SiteDocument['runtime']['scripts']): SiteDocument {
  return {
    id: 'site-1',
    name: 'Preview Runtime Site',
    pages: [page],
    visualComponents: [],
    layouts: [],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: structuredClone(DEFAULT_SITE_SETTINGS),
    styleRules: {},
    files,
    explorer: createDefaultSiteExplorerOrganization(),
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: {
      dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
      styles: {},
      scripts,
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

/** The bytes a browser gets for every script the preview page references. */
async function servedScripts(site: SiteDocument, page: Page): Promise<string[]> {
  const { runtimeAssets } = await buildPreviewRuntime(site, page)
  expect(runtimeAssets.scripts.length).toBeGreaterThan(0)
  return runtimeAssets.scripts.map((script) => {
    const asset = readPreviewAsset(script.src)
    expect(asset).not.toBeNull()
    return new TextDecoder().decode(asset!.bytes)
  })
}

describe('branch preview runtime builds', () => {
  beforeEach(() => resetPreviewBuilds())

  it('serves the edited bytes when only a classic script content changes', async () => {
    const page = makePage()
    const scripts = { motion: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, format: 'classic' as const } }
    const before = makeSite(page, [scriptFile('motion', 'bake/motion.js', 'window.motion = "before";')], scripts)
    const after = makeSite(page, [scriptFile('motion', 'bake/motion.js', 'window.motion = "after";')], scripts)

    expect((await servedScripts(before, page)).join('\n')).toContain('before')
    const served = (await servedScripts(after, page)).join('\n')
    expect(served).toContain('after')
    expect(served).not.toContain('before')
  })

  it('serves the edited bytes when only a module imported by the entry script changes', async () => {
    const page = makePage()
    const scripts = { helper: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, enabled: false } }
    const entry = scriptFile('entry', 'bake/entry.js', 'import { label } from "./helper.js"; window.label = label;')
    const before = makeSite(page, [entry, scriptFile('helper', 'bake/helper.js', 'export const label = "before";')], scripts)
    const after = makeSite(page, [entry, scriptFile('helper', 'bake/helper.js', 'export const label = "after";')], scripts)

    expect((await servedScripts(before, page)).join('\n')).toContain('before')
    const served = (await servedScripts(after, page)).join('\n')
    expect(served).toContain('after')
    expect(served).not.toContain('before')
  })

  it('reuses the build when only a file outside the bundle changes', async () => {
    const page = makePage()
    const scripts = { motion: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, format: 'classic' as const } }
    const motion = scriptFile('motion', 'bake/motion.js', 'window.motion = 1;')
    const doc = (content: string): SiteFile => ({ id: 'notes', path: 'notes.md', type: 'doc', content, createdAt: 1, updatedAt: 1 })
    const first = await buildPreviewRuntime(makeSite(page, [motion, doc('one')], scripts), page)
    const second = await buildPreviewRuntime(makeSite(page, [motion, doc('two')], scripts), page)

    expect(second.runtimeAssets.scripts.map((script) => script.src))
      .toEqual(first.runtimeAssets.scripts.map((script) => script.src))
  })
})
