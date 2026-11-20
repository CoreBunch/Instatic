/**
 * Importing the same site twice (#404).
 *
 * Drives the real store commit (`createSiteImportAdapter().commit` →
 * `mutateAllPagesAndSite`) so the test exercises the one place that decides
 * whether an incoming rule is "that rule arriving again" or a new one.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import '@modules/base'
import { useEditorStore } from '@site/store/store'
import {
  applyConflictResolutions,
  buildImportPlan,
  commitImportPlan,
  detectMediaConflicts,
  hashImportAssets,
} from '@core/siteImport'
import type { ExistingMediaMatch, FileMap, ImportPlan, ImportResult, SiteImportAdapter } from '@core/siteImport'
import type { StyleRule } from '@core/page-tree'
import { createSiteImportAdapter } from '@admin/modals/SiteImport/shared/createSiteImportAdapter'
import { makeSite } from '../fixtures'

const enc = new TextEncoder()

const INDEX_HTML =
  '<!doctype html><html><head><title>Home</title><link rel="stylesheet" href="style.css"></head>'
  + '<body><h1 class="hero">Hi</h1></body></html>'

/** The stylesheet declares `h1` twice on purpose — both declarations must survive. */
const STYLE_CSS = 'h1 { margin: 0 }\nbody { color: white }\nh1 { color: red }\n.hero { color: blue }\n'

function fileMap(css: string = STYLE_CSS): FileMap {
  return {
    files: {
      'index.html': { bytes: enc.encode(INDEX_HTML), mimeType: 'text/html' },
      'style.css': { bytes: enc.encode(css), mimeType: 'text/css' },
    },
  }
}

const USER_BODY_RULE: StyleRule = {
  id: 'user-body',
  name: 'body',
  kind: 'ambient',
  selector: 'body',
  order: 0,
  styles: { color: 'black' },
  contextStyles: {},
  createdAt: 1,
  updatedAt: 1,
}

async function importSite(css?: string): Promise<ImportResult> {
  const site = useEditorStore.getState().site!
  const plan = buildImportPlan({ fileMap: fileMap(css), currentSite: site })
  const resolved = applyConflictResolutions(
    plan,
    plan.conflicts.pages,
    plan.conflicts.rules,
    plan.conflicts.tokens,
    plan.conflicts.crossSheetClasses,
  )
  const adapter: SiteImportAdapter = {
    ...createSiteImportAdapter({ sessionId: 'reimport-test' }),
    uploadAsset: async () => {
      throw new Error('this fixture has no assets')
    },
  }
  return commitImportPlan(resolved, adapter)
}

function ambientRules(selector: string): Array<{ id: string; order: number; styles: Record<string, unknown> }> {
  const site = useEditorStore.getState().site!
  return Object.values(site.styleRules)
    .filter((rule) => rule.kind === 'ambient' && rule.selector === selector)
    .sort((a, b) => a.order - b.order)
    .map((rule) => ({ id: rule.id, order: rule.order, styles: rule.styles }))
}

describe('commitImportPlan — importing the same site twice', () => {
  beforeEach(() => {
    useEditorStore.setState({
      site: makeSite({ styleRules: { [USER_BODY_RULE.id]: { ...USER_BODY_RULE } } }),
    } as Parameters<typeof useEditorStore.setState>[0])
  })

  it('keeps one copy of every imported ambient rule, in place, with its cascade order', async () => {
    await importSite()
    const h1AfterFirst = ambientRules('h1')
    const bodyAfterFirst = ambientRules('body')
    expect(h1AfterFirst).toHaveLength(2)
    expect(bodyAfterFirst).toHaveLength(2) // the user's rule + the imported one

    await importSite()

    expect(ambientRules('h1').map((r) => [r.id, r.order]))
      .toEqual(h1AfterFirst.map((r) => [r.id, r.order]))
    expect(ambientRules('body').map((r) => [r.id, r.order]))
      .toEqual(bodyAfterFirst.map((r) => [r.id, r.order]))
  })

  it('leaves a user-authored ambient rule under the same selector untouched', async () => {
    await importSite()
    await importSite()

    const user = useEditorStore.getState().site!.styleRules[USER_BODY_RULE.id]!
    expect(user.styles).toEqual({ color: 'black' })
    expect(user.updatedAt).toBe(USER_BODY_RULE.updatedAt)
  })

  it('replaces a re-imported rule\'s declarations in place when the stylesheet changed', async () => {
    await importSite()
    const [importedBody] = ambientRules('body').filter((r) => r.id !== USER_BODY_RULE.id)
    expect(importedBody?.styles).toEqual({ color: 'white' })

    await importSite(STYLE_CSS.replace('body { color: white }', 'body { color: navy }'))

    const bodies = ambientRules('body').filter((r) => r.id !== USER_BODY_RULE.id)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({ ...importedBody!, styles: { color: 'navy' } })
  })
})

// ---------------------------------------------------------------------------
// Scripts, kept stylesheets and media arriving again
// ---------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

function bundleWithFiles(script = 'console.info("app")', slug = 'about'): FileMap {
  return {
    files: {
      [`${slug}.html`]: {
        bytes: enc.encode(
          `<!doctype html><html><head><title>${slug}</title><script src="app.js"></script></head>`
          + '<body><img src="logo.png" alt="Logo"></body></html>',
        ),
        mimeType: 'text/html',
      },
      'app.js': { bytes: enc.encode(script), mimeType: 'text/javascript' },
      'logo.png': { bytes: PNG_BYTES, mimeType: 'image/png' },
    },
  }
}

/** A tiny media library: hash → the asset an earlier upload created. */
let library: ExistingMediaMatch[] = []
let uploads: string[] = []

async function importBundle(
  map: FileMap,
  choose: (plan: ImportPlan) => ImportPlan = (plan) => plan,
): Promise<ImportPlan> {
  const site = useEditorStore.getState().site!
  const built = buildImportPlan({ fileMap: map, currentSite: site })
  const hashBySource = await hashImportAssets(built.assets)
  const plan = choose(detectMediaConflicts(built, hashBySource, library))
  const resolved = applyConflictResolutions(
    plan,
    plan.conflicts.pages,
    plan.conflicts.rules,
    plan.conflicts.tokens,
    plan.conflicts.crossSheetClasses,
  )
  const adapter: SiteImportAdapter = {
    ...createSiteImportAdapter({ sessionId: 'reimport-files-test' }),
    uploadAsset: async ({ path, bytes }) => {
      uploads.push(path)
      const url = `/uploads/${uploads.length}-${path}`
      library.push({ contentHash: hashBySource.get(path)!, id: `asset-${uploads.length}`, publicPath: url, filename: path })
      expect(bytes).toBe(map.files[path]!.bytes)
      return { url, warnings: [] }
    },
  }
  await commitImportPlan(resolved, adapter)
  return plan
}

function scriptFiles() {
  return useEditorStore.getState().site!.files.filter((f) => f.type === 'script')
}

function scriptScope(fileId: string) {
  return useEditorStore.getState().site!.runtime?.scripts?.[fileId]?.scope
}

function pageId(slug: string): string {
  return useEditorStore.getState().site!.pages.find((p) => p.slug === slug)!.id
}

function withPageResolution(action: 'overwrite' | 'auto-rename') {
  return (plan: ImportPlan): ImportPlan => ({
    ...plan,
    conflicts: {
      ...plan.conflicts,
      pages: plan.conflicts.pages.map((c) => ({
        ...c,
        defaultResolution: action === 'overwrite' ? { action } : c.defaultResolution,
      })),
    },
  })
}

describe('commitImportPlan — scripts and media arriving again', () => {
  beforeEach(() => {
    library = []
    uploads = []
    useEditorStore.setState({ site: makeSite() } as Parameters<typeof useEditorStore.setState>[0])
  })

  it('reuses the script and the uploaded image instead of adding -2 copies', async () => {
    await importBundle(bundleWithFiles())
    const [script] = scriptFiles()
    expect(uploads).toEqual(['logo.png'])

    const second = await importBundle(bundleWithFiles(), withPageResolution('overwrite'))

    expect(second.conflicts.files).toEqual([
      expect.objectContaining({ kind: 'script', path: 'app.js', sitePath: 'app.js', existingFileId: script!.id }),
    ])
    expect(second.conflicts.media).toEqual([
      expect.objectContaining({ sourcePath: 'logo.png', existingAssetId: 'asset-1', defaultResolution: { action: 'skip' } }),
    ])
    expect(scriptFiles().map((f) => f.path)).toEqual(['app.js'])
    expect(uploads).toEqual(['logo.png'])
  })

  it('points a reused image at the existing asset URL', async () => {
    await importBundle(bundleWithFiles())
    await importBundle(bundleWithFiles('console.info("app")', 'pricing'))

    const pricing = useEditorStore.getState().site!.pages.find((p) => p.slug === 'pricing')!
    const image = Object.values(pricing.nodes).find((n) => n.moduleId === 'base.image')!
    expect(JSON.stringify(image.props)).toContain('/uploads/1-logo.png')
  })

  it('lets a page the second import adds load the reused script', async () => {
    await importBundle(bundleWithFiles())
    const [script] = scriptFiles()
    await importBundle(bundleWithFiles('console.info("app")', 'pricing'))

    expect(scriptFiles()).toHaveLength(1)
    expect(scriptScope(script!.id)).toEqual({ type: 'pages', pageIds: [pageId('about'), pageId('pricing')] })
  })

  it('keeps the existing script content by default and replaces it on overwrite', async () => {
    await importBundle(bundleWithFiles())
    await importBundle(bundleWithFiles('console.info("v2")'), withPageResolution('overwrite'))
    expect(scriptFiles().map((f) => f.content)).toEqual(['console.info("app")'])

    await importBundle(bundleWithFiles('console.info("v2")'), (plan) => ({
      ...withPageResolution('overwrite')(plan),
      conflicts: {
        ...withPageResolution('overwrite')(plan).conflicts,
        files: plan.conflicts.files.map((c) => ({ ...c, defaultResolution: { action: 'overwrite' } })),
      },
    }))
    expect(scriptFiles().map((f) => [f.path, f.content])).toEqual([['app.js', 'console.info("v2")']])
  })

  it('still adds a copy and uploads again when the user asks for it', async () => {
    await importBundle(bundleWithFiles())
    await importBundle(bundleWithFiles(), (plan) => ({
      ...plan,
      conflicts: {
        ...plan.conflicts,
        files: plan.conflicts.files.map((c) => ({ ...c, defaultResolution: { action: 'auto-rename' } })),
        media: plan.conflicts.media.map((c) => ({ ...c, defaultResolution: { action: 'auto-rename' } })),
      },
    }))

    expect(scriptFiles().map((f) => f.path)).toEqual(['app.js', 'app-2.js'])
    expect(uploads).toEqual(['logo.png', 'logo.png'])
  })
})
