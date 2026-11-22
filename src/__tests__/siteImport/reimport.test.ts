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
import type { SiteDocument, StyleRule } from '@core/page-tree'
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

  it('reuses imported class bindings and design tokens on a repeat import', async () => {
    const css = ':root { --accent: #defabc; --font-label: sans-serif }\n.hero { color: var(--accent) }'
    await importSite(css)
    const ids = Object.keys(useEditorStore.getState().site!.styleRules)
    const result = await importSite(css)
    expect(result.conflicts.rules.find((row) => row.desiredName === 'hero')?.defaultResolution.action).toBe('skip')
    expect(result.conflicts.tokens.map((row) => [row.desiredVariable, row.defaultResolution.action]))
      .toEqual([['accent', 'skip'], ['font-label', 'skip']])
    expect(Object.keys(useEditorStore.getState().site!.styleRules)).toEqual(ids)
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

describe('commitImportPlan — re-importing a confined page stylesheet', () => {
  const KIT_FILES = (overrideColor: string): FileMap => ({
    files: {
      'a.html': { bytes: enc.encode('<html><head><link rel="stylesheet" href="kit.css"><link rel="stylesheet" href="a.css"></head><body><a class="btn">A</a></body></html>'), mimeType: 'text/html' },
      'b.html': { bytes: enc.encode('<html><head><link rel="stylesheet" href="kit.css"></head><body><a class="btn">B</a></body></html>'), mimeType: 'text/html' },
      'kit.css': { bytes: enc.encode('.btn { color: black }\n'), mimeType: 'text/css' },
      'a.css': { bytes: enc.encode(`.btn { color: ${overrideColor} }\n.btn:hover { color: maroon }\n`), mimeType: 'text/css' },
    },
  })

  async function importKit(overrideColor: string, ruleAction: 'overwrite' | null) {
    const site = useEditorStore.getState().site!
    const plan = buildImportPlan({ fileMap: KIT_FILES(overrideColor), currentSite: site })
    const rules = plan.conflicts.rules.map((c) => (ruleAction ? { ...c, defaultResolution: { action: ruleAction } } : c))
    const resolved = applyConflictResolutions(plan, plan.conflicts.pages, rules, plan.conflicts.tokens, plan.conflicts.crossSheetClasses)
    const adapter: SiteImportAdapter = {
      ...createSiteImportAdapter({ sessionId: 'reimport-confined' }),
      uploadAsset: async () => { throw new Error('no assets') },
    }
    await commitImportPlan(resolved, adapter)
    return plan
  }

  beforeEach(() => {
    useEditorStore.setState({ site: makeSite() } as Parameters<typeof useEditorStore.setState>[0])
  })

  it('reuses the name the first import gave the sheet and updates its rules in place', async () => {
    const first = await importKit('red', null)
    expect(first.conflicts.crossSheetClasses.map((c) => c.defaultResolution.resolvedName)).toEqual(['btn-2'])
    const confined = () => Object.values(useEditorStore.getState().site!.styleRules)
      .filter((rule) => rule.origin?.source === 'a.css')
      .map((rule) => [rule.id, rule.selector, rule.styles.color])
    const before = confined()
    expect(before.map(([, selector]) => selector).sort()).toEqual(['.btn-2', '.btn-2:hover'])

    const second = await importKit('blue', 'overwrite')
    expect(second.conflicts.crossSheetClasses.map((c) => c.defaultResolution.resolvedName)).toEqual(['btn-2'])
    const after = confined()
    expect(after.map(([id, selector]) => [id, selector])).toEqual(before.map(([id, selector]) => [id, selector]))
    expect(after.find(([, selector]) => selector === '.btn-2')?.[2]).toBe('blue')
  })
})

// ---------------------------------------------------------------------------
// Scripts, kept stylesheets and media arriving again
// ---------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

function bundleWithFiles(script = 'console.info("app")', slug = 'about', scriptType = ''): FileMap {
  return {
    files: {
      [`${slug}.html`]: {
        bytes: enc.encode(
          `<!doctype html><html><head><title>${slug}</title><script${scriptType ? ` type="${scriptType}"` : ''} src="app.js"></script></head>`
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
let lastResult: ImportResult | null = null

async function importBundle(
  map: FileMap,
  choose: (plan: ImportPlan) => ImportPlan = (plan) => plan,
  options: Parameters<typeof buildImportPlan>[0]['options'] = undefined,
): Promise<ImportPlan> {
  const site = useEditorStore.getState().site!
  const built = buildImportPlan({ fileMap: map, currentSite: site, options })
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
  lastResult = await commitImportPlan(resolved, adapter)
  return plan
}

/** Change the loaded site the way an edit in Instatic would, outside any import. */
function editSite(edit: (site: SiteDocument) => void): void {
  const site = structuredClone(useEditorStore.getState().site!)
  edit(site)
  useEditorStore.setState({ site } as Parameters<typeof useEditorStore.setState>[0])
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

  it('replaces a changed script by default and keeps it when the user picks Use existing', async () => {
    await importBundle(bundleWithFiles())
    await importBundle(bundleWithFiles('console.info("v2")'), (plan) => ({
      ...withPageResolution('overwrite')(plan),
      conflicts: {
        ...withPageResolution('overwrite')(plan).conflicts,
        files: plan.conflicts.files.map((c) => ({ ...c, defaultResolution: { action: 'skip' } })),
      },
    }))
    expect(scriptFiles().map((f) => f.content)).toEqual(['console.info("app")'])

    await importBundle(bundleWithFiles('console.info("v2")'), withPageResolution('overwrite'))
    expect(scriptFiles().map((f) => [f.path, f.content])).toEqual([['app.js', 'console.info("v2")']])
  })

  it('replacing a script applies its new format, load order and npm dependencies', async () => {
    await importBundle(bundleWithFiles())
    const [script] = scriptFiles()
    expect(useEditorStore.getState().site!.runtime?.scripts?.[script!.id]?.format).toBe('classic')

    await importBundle(
      bundleWithFiles('import dayjs from "https://esm.sh/dayjs@1.11.10"\nconsole.info(dayjs())', 'about', 'module'),
      (plan) => ({
        ...withPageResolution('overwrite')(plan),
        conflicts: {
          ...withPageResolution('overwrite')(plan).conflicts,
          files: plan.conflicts.files.map((c) => ({ ...c, defaultResolution: { action: 'overwrite' } })),
        },
      }),
    )

    const site = useEditorStore.getState().site!
    expect(scriptFiles().map((f) => f.id)).toEqual([script!.id])
    expect(scriptFiles()[0]!.content).toContain('from "dayjs"')
    expect(site.runtime?.scripts?.[script!.id]?.format).toBe('module')
    expect(site.packageJson.dependencies.dayjs).toBe('1.11.10')
  })

  it('updates timing and placement when only the script tag changes across imports', async () => {
    await importBundle(bundleWithFiles())
    const [script] = scriptFiles()
    const runtime = () => useEditorStore.getState().site!.runtime!.scripts![script!.id]
    expect(runtime()).toMatchObject({ placement: 'head', timing: 'immediate' })

    const deferred = bundleWithFiles()
    const html = deferred.files['about.html']!
    html.bytes = enc.encode(new TextDecoder().decode(html.bytes).replace('<script src=', '<script defer src='))
    await importBundle(deferred, withPageResolution('overwrite'))
    expect(runtime()).toMatchObject({ placement: 'body-end', timing: 'dom-ready' })

    await importBundle(bundleWithFiles(), withPageResolution('overwrite'))
    expect(runtime()).toMatchObject({ placement: 'head', timing: 'immediate' })
    expect(scriptFiles()).toHaveLength(1)
  })

  it('keeps the load order the site already gives a replaced script', async () => {
    await importBundle(bundleWithFiles())
    const [script] = scriptFiles()
    editSite((site) => {
      site.runtime!.scripts![script!.id]!.priority = 250
    })

    await importBundle(bundleWithFiles('console.info("v2")'), withPageResolution('overwrite'))

    expect(scriptFiles()[0]!.content).toBe('console.info("v2")')
    expect(useEditorStore.getState().site!.runtime?.scripts?.[script!.id]?.priority).toBe(250)
  })

  it('updates the version of an npm package a replaced script now asks for', async () => {
    const dayjs = (version: string) =>
      bundleWithFiles(`import dayjs from "https://esm.sh/dayjs@${version}"\nconsole.info(dayjs())`, 'about', 'module')
    await importBundle(dayjs('1.11.10'))
    expect(useEditorStore.getState().site!.packageJson.dependencies.dayjs).toBe('1.11.10')

    await importBundle(dayjs('1.11.13'), withPageResolution('overwrite'))

    expect(useEditorStore.getState().site!.packageJson.dependencies.dayjs).toBe('1.11.13')
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

// ---------------------------------------------------------------------------
// What changed since the last import: the bundle, the site copy, or neither
// ---------------------------------------------------------------------------

function keptSheetBundle(css: string): FileMap {
  return {
    files: {
      'about.html': {
        bytes: enc.encode('<!doctype html><html><head><title>about</title><link rel="stylesheet" href="kit.css"></head><body><p>x</p></body></html>'),
        mimeType: 'text/html',
      },
      'kit.css': { bytes: enc.encode(css), mimeType: 'text/css' },
      'logo.png': { bytes: PNG_BYTES, mimeType: 'image/png' },
    },
  }
}

const KEEP_KIT = { stylesheetModes: { 'kit.css': 'file' as const } }
const KIT_CSS = '.hero { background: url("logo.png") }\n'

function styleFiles() {
  return useEditorStore.getState().site!.files.filter((f) => f.type === 'style')
}

describe('commitImportPlan — telling bundle changes from edits made in Instatic', () => {
  beforeEach(() => {
    library = []
    uploads = []
    useEditorStore.setState({ site: makeSite() } as Parameters<typeof useEditorStore.setState>[0])
  })

  it('reads a kept stylesheet with url()s as unchanged when the bundle did not change it', async () => {
    await importBundle(keptSheetBundle(KIT_CSS), undefined, KEEP_KIT)
    expect(styleFiles()[0]!.content).toContain('/uploads/1-logo.png')

    const second = await importBundle(keptSheetBundle(KIT_CSS), withPageResolution('overwrite'), KEEP_KIT)

    expect(second.conflicts.files).toEqual([
      expect.objectContaining({ kind: 'style', path: 'kit.css', state: 'unchanged', defaultResolution: { action: 'skip' } }),
    ])
  })

  it('replaces a file the bundle changed when nobody edited it in Instatic', async () => {
    await importBundle(bundleWithFiles())
    const second = await importBundle(bundleWithFiles('console.info("v2")'), withPageResolution('overwrite'))

    expect(second.conflicts.files).toEqual([
      expect.objectContaining({ state: 'changed', defaultResolution: { action: 'overwrite' } }),
    ])
    expect(scriptFiles()[0]!.content).toBe('console.info("v2")')
  })

  it('keeps a file edited in Instatic by default even when the bundle changed it too', async () => {
    await importBundle(bundleWithFiles())
    const [script] = scriptFiles()
    editSite((site) => {
      site.files.find((f) => f.id === script!.id)!.content = 'console.info("hand edit")'
    })

    const second = await importBundle(bundleWithFiles('console.info("v2")'), withPageResolution('overwrite'))

    expect(second.conflicts.files).toEqual([
      expect.objectContaining({ state: 'edited', defaultResolution: { action: 'skip' } }),
    ])
    expect(scriptFiles()[0]!.content).toBe('console.info("hand edit")')
  })

  it('leaves a file untouched when Replace brings exactly what it already holds', async () => {
    await importBundle(bundleWithFiles())
    const before = scriptFiles()[0]!

    await importBundle(bundleWithFiles(), overwriteEverything)

    expect(scriptFiles()[0]).toBe(before)
  })

  it('keeps a file with no import record by default when its content differs', async () => {
    editSite((site) => {
      site.files.push({ id: 'hand', path: 'app.js', type: 'script', content: 'console.info("mine")', createdAt: 1, updatedAt: 1 })
    })

    const plan = await importBundle(bundleWithFiles())

    expect(plan.conflicts.files).toEqual([
      expect.objectContaining({ state: 'differs', defaultResolution: { action: 'skip' } }),
    ])
  })
})

// ---------------------------------------------------------------------------
// Load order across imports
// ---------------------------------------------------------------------------

function pageLinking(slug: string, scripts: string[], sheets: string[] = []): Record<string, { bytes: Uint8Array; mimeType: string }> {
  const links = sheets.map((s) => `<link rel="stylesheet" href="${s}">`).join('')
  const tags = scripts.map((s) => `<script src="${s}"></script>`).join('')
  return {
    [`${slug}.html`]: {
      bytes: enc.encode(`<!doctype html><html><head><title>${slug}</title>${links}${tags}</head><body><p>${slug}</p></body></html>`),
      mimeType: 'text/html',
    },
  }
}

function textFiles(names: string[], version = 'v1'): Record<string, { bytes: Uint8Array; mimeType: string }> {
  return Object.fromEntries(names.map((name) => [
    name,
    { bytes: enc.encode(name.endsWith('.css') ? `.${name.replace('.css', '')} { color: red } /* ${version} */\n` : `console.info("${name} ${version}")`), mimeType: '' },
  ]))
}

/** Files of a kind in the order the runtime loads them, failing on any priority tie. */
function loadOrder(type: 'script' | 'style'): string[] {
  const site = useEditorStore.getState().site!
  const entries = site.files
    .filter((f) => f.type === type)
    .map((f) => ({ path: f.path, priority: (type === 'script' ? site.runtime?.scripts : site.runtime?.styles)?.[f.id]?.priority ?? 100 }))
  expect(new Set(entries.map((e) => e.priority)).size).toBe(entries.length)
  return entries.toSorted((a, b) => a.priority - b.priority).map((e) => e.path)
}

const overwriteEverything = (plan: ImportPlan): ImportPlan => ({
  ...withPageResolution('overwrite')(plan),
  conflicts: {
    ...withPageResolution('overwrite')(plan).conflicts,
    files: plan.conflicts.files.map((c) => ({ ...c, defaultResolution: { action: 'overwrite' } })),
  },
})

describe('commitImportPlan — load order across imports', () => {
  beforeEach(() => {
    library = []
    uploads = []
    useEditorStore.setState({ site: makeSite() } as Parameters<typeof useEditorStore.setState>[0])
  })

  it('re-imports two distinct bundle paths that map to the same site filename', async () => {
    const first = 'src/pages/about/app.js'
    const second = 'src/pages/pricing/app.js'
    const bundle = (paths: string[], version: string) => ({ files: {
      ...modulePage('about', paths),
      ...moduleFiles({ [first]: `console.info("about ${version}")`, [second]: `console.info("pricing ${version}")` }),
    } })
    await importBundle(bundle([first, second], 'v1'))
    const ids = new Map(scriptFiles().map((file) => [file.content, file.id]))
    await importBundle(bundle([second, first], 'v2'), overwriteEverything)
    expect(scriptFiles()).toHaveLength(2)
    for (const page of ['about', 'pricing']) {
      expect(scriptFiles().find((file) => file.content === `console.info("${page} v2")`)?.id)
        .toBe(ids.get(`console.info("${page} v1")`))
    }
  })

  it('slots a script new in this import between the replaced ones it sits between', async () => {
    await importBundle({ files: { ...pageLinking('about', ['a.js', 'c.js']), ...textFiles(['a.js', 'c.js']) } })
    await importBundle(
      { files: { ...pageLinking('about', ['a.js', 'z.js', 'c.js']), ...textFiles(['a.js', 'z.js', 'c.js'], 'v2') } },
      overwriteEverything,
    )
    expect(loadOrder('script')).toEqual(['a.js', 'z.js', 'c.js'])
  })

  it('keeps the order of a page the re-import does not touch', async () => {
    await importBundle({
      files: { ...pageLinking('index', ['jquery.js', 'app.js']), ...pageLinking('about', ['app.js']), ...textFiles(['jquery.js', 'app.js']) },
    })
    expect(loadOrder('script')).toEqual(['jquery.js', 'app.js'])

    await importBundle({ files: { ...pageLinking('about', ['app.js']), ...textFiles(['app.js'], 'v2') } }, overwriteEverything)

    expect(loadOrder('script')).toEqual(['jquery.js', 'app.js'])
  })

  it('slots a kept stylesheet new in this import between the replaced ones', async () => {
    const keep = (names: string[]) => ({ stylesheetModes: Object.fromEntries(names.map((n) => [n, 'file' as const])) })
    await importBundle({ files: { ...pageLinking('about', [], ['a.css', 'c.css']), ...textFiles(['a.css', 'c.css']) } }, undefined, keep(['a.css', 'c.css']))
    await importBundle(
      { files: { ...pageLinking('about', [], ['a.css', 'z.css', 'c.css']), ...textFiles(['a.css', 'z.css', 'c.css'], 'v2') } },
      overwriteEverything,
      keep(['a.css', 'z.css', 'c.css']),
    )
    expect(loadOrder('style')).toEqual(['a.css', 'z.css', 'c.css'])
  })
})

// ---------------------------------------------------------------------------
// npm versions a replaced script asks for
// ---------------------------------------------------------------------------

function moduleFiles(scripts: Record<string, string>): Record<string, { bytes: Uint8Array; mimeType: string }> {
  return Object.fromEntries(Object.entries(scripts).map(([name, content]) => [name, { bytes: enc.encode(content), mimeType: '' }]))
}

function modulePage(slug: string, scripts: string[]): Record<string, { bytes: Uint8Array; mimeType: string }> {
  const tags = scripts.map((s) => `<script type="module" src="${s}"></script>`).join('')
  return {
    [`${slug}.html`]: {
      bytes: enc.encode(`<!doctype html><html><head><title>${slug}</title>${tags}</head><body><p>${slug}</p></body></html>`),
      mimeType: 'text/html',
    },
  }
}

const usesDayjs = (version: string, tag = '') =>
  `import dayjs from "https://esm.sh/dayjs${version ? `@${version}` : ''}"\nconsole.info(dayjs(), ${JSON.stringify(tag)})`

function dependencyWarnings(): string[] {
  return (lastResult?.warnings ?? []).filter((w) => w.kind === 'dependency-version-kept').map((w) => w.path ?? '')
}

describe('commitImportPlan — npm versions of a replaced script', () => {
  beforeEach(() => {
    library = []
    uploads = []
    lastResult = null
    useEditorStore.setState({ site: makeSite() } as Parameters<typeof useEditorStore.setState>[0])
  })

  const dayjs = () => useEditorStore.getState().site!.packageJson.dependencies.dayjs

  it('never loosens a pinned version to an unpinned CDN import', async () => {
    await importBundle({ files: { ...modulePage('about', ['app.js']), ...moduleFiles({ 'app.js': usesDayjs('1.11.10') }) } })
    await importBundle({ files: { ...modulePage('about', ['app.js']), ...moduleFiles({ 'app.js': usesDayjs('') }) } }, overwriteEverything)
    expect(dayjs()).toBe('1.11.10')
  })

  it('keeps the listed version, with a warning, while a script outside the import still uses it', async () => {
    await importBundle({
      files: {
        ...modulePage('index', ['other.js']),
        ...modulePage('about', ['app.js']),
        ...moduleFiles({ 'other.js': usesDayjs('1.11.10', 'other'), 'app.js': usesDayjs('1.11.10', 'app') }),
      },
    })
    await importBundle(
      { files: { ...modulePage('about', ['app.js']), ...moduleFiles({ 'app.js': usesDayjs('1.11.13', 'app') }) } },
      overwriteEverything,
    )
    expect(dayjs()).toBe('1.11.10')
    expect(dependencyWarnings()).toEqual(['dayjs'])
  })

  it('allows an update when another script only mentions the import in a comment', async () => {
    await importBundle({ files: {
      ...modulePage('about', ['app.js', 'other.js']),
      ...moduleFiles({ 'app.js': usesDayjs('1.11.10'), 'other.js': '// import "dayjs"\nconsole.info("other")' }),
    } })
    await importBundle({ files: { ...modulePage('about', ['app.js']), ...moduleFiles({ 'app.js': usesDayjs('1.11.13') }) } }, overwriteEverything)
    expect(dayjs()).toBe('1.11.13')
    expect(dependencyWarnings()).toEqual([])
  })

  it('keeps a pinned prerelease with build metadata when the replacement asks for a range', async () => {
    const bundle = (version: string) => ({ files: { ...modulePage('about', ['app.js']), ...moduleFiles({ 'app.js': usesDayjs(version) }) } })
    await importBundle(bundle('1.11.10-rc.1+build.2'))
    await importBundle(bundle('^1.11.10'), overwriteEverything)
    expect(dayjs()).toBe('1.11.10-rc.1+build.2')
    expect(dependencyWarnings()).toEqual(['dayjs'])
  })

  it('warns instead of picking one when two replaced scripts ask different versions', async () => {
    const bundle = (a: string, b: string) => ({
      files: { ...modulePage('about', ['a.js', 'b.js']), ...moduleFiles({ 'a.js': usesDayjs(a, 'a'), 'b.js': usesDayjs(b, 'b') }) },
    })
    await importBundle(bundle('1.11.10', '1.11.10'))
    await importBundle(bundle('1.11.12', '1.11.13'), overwriteEverything)
    expect(dayjs()).toBe('1.11.10')
    expect(dependencyWarnings()).toEqual(['dayjs'])
  })
})
