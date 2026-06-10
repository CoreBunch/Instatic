/**
 * Unit tests for applyImport — the full import pipeline orchestrator.
 *
 * Covers:
 *   - buildImportPlan: shape-agnostic round-trip with the sample fixture
 *   - commitImportPlan: mock adapter records all operations
 *   - Conflict resolution branches (auto-rename, skip, overwrite)
 *   - "Unused CSS" detection
 *   - Atomicity: forced upload failure leaves no partial store state
 */

import { describe, it, expect } from 'bun:test'
// Self-registers all base modules with the global registry so importHtml works
import '@modules/base'
import {
  buildImportPlan,
  commitImportPlan,
  applyConflictResolutions,
} from '@core/siteImport'
import type {
  SiteImportAdapter,
  SiteImportTransaction,
  ImportPlan,
  NewStyleRule,
  PageConflict,
  RuleConflict,
} from '@core/siteImport'
import type { FontEntry } from '@core/fonts'
import type { ImportFragment } from '@core/htmlImport'
import { makeSampleFileMap, makeEmptySiteDocument, makeMockSiteDocument } from './mockSite'
import { makeSinglePageFileMap } from './fixtures'
import type { FileMap } from '@core/siteImport'

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

interface MockTxOp {
  type:
    | 'addPage'
    | 'overwritePage'
    | 'addStyleRule'
    | 'overwriteStyleRule'
    | 'addFonts'
    | 'addInstalledFonts'
    | 'addFontTokens'
    | 'overwriteFontTokens'
    | 'addConditions'
    | 'addColorTokens'
    | 'overwriteColorTokens'
    | 'addScripts'
    | 'addStylesheets'
  args: unknown
  id: string
}

function makeMockAdapter(opts?: {
  uploadFail?: boolean
  commitFail?: boolean
}): SiteImportAdapter & {
  uploads: string[]
  installs: { family: string; variants: string[]; subsets: string[] }[]
  ops: MockTxOp[]
} {
  let idCounter = 0
  const nextId = () => `mock-id-${++idCounter}`
  const uploads: string[] = []
  const installs: { family: string; variants: string[]; subsets: string[] }[] = []
  const ops: MockTxOp[] = []

  return {
    uploads,
    installs,
    async installGoogleFont(request) {
      installs.push(request)
      return {
        id: `font-${request.family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        source: 'google',
        family: request.family,
        variants: request.variants,
        subsets: request.subsets,
        files: request.variants.map((variant) => ({
          variant,
          subset: request.subsets[0] ?? 'latin',
          path: `/uploads/fonts/${request.family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${variant}.woff2`,
          format: 'woff2',
        })),
        createdAt: 1,
        updatedAt: 1,
      } satisfies FontEntry
    },
    ops,
    async uploadAsset(file) {
      if (opts?.uploadFail) throw new Error('upload failure')
      uploads.push(file.path)
      return `/uploads/media/${file.path.replace(/[^a-z0-9.]/g, '_')}`
    },
    async commit(recipe) {
      if (opts?.commitFail) throw new Error('commit failure')
      const tx: SiteImportTransaction = {
        addPage(input) {
          const id = nextId()
          ops.push({ type: 'addPage', args: input, id })
          return id
        },
        overwritePage(pageId, input) {
          const id = pageId
          ops.push({ type: 'overwritePage', args: { pageId, ...input }, id })
        },
        addStyleRule(rule) {
          const id = nextId()
          ops.push({ type: 'addStyleRule', args: rule, id })
          return id
        },
        overwriteStyleRule(ruleId, rule) {
          ops.push({ type: 'overwriteStyleRule', args: { ruleId, rule }, id: ruleId })
        },
        addFonts(fonts) {
          ops.push({ type: 'addFonts', args: { fonts }, id: '' })
          return fonts.map((f) => ({ id: nextId(), family: f.family }))
        },
        addInstalledFonts(fonts) {
          ops.push({ type: 'addInstalledFonts', args: { fonts }, id: '' })
          return fonts.map((f) => ({ id: f.id, family: f.family }))
        },
        addFontTokens(tokens) {
          ops.push({ type: 'addFontTokens', args: { tokens }, id: '' })
          return tokens.map((t) => ({ id: nextId(), name: t.name, variable: t.variable }))
        },
        overwriteFontTokens(items) {
          ops.push({ type: 'overwriteFontTokens', args: { items }, id: '' })
          return items.map((i) => ({
            id: i.existingTokenId,
            name: i.token.name,
            variable: i.token.variable,
          }))
        },
        addConditions(conditions) {
          ops.push({ type: 'addConditions', args: { conditions }, id: '' })
        },
        addColorTokens(colors) {
          ops.push({ type: 'addColorTokens', args: { colors }, id: '' })
          return colors.map((c) => ({ slug: c.slug, value: c.value }))
        },
        overwriteColorTokens(items) {
          ops.push({ type: 'overwriteColorTokens', args: { items }, id: '' })
          return items.map((i) => ({ slug: i.existingTokenId, value: i.value }))
        },
        addStylesheets(stylesheets) {
          ops.push({ type: 'addStylesheets', args: { stylesheets }, id: '' })
          return stylesheets.map((s) => ({ id: nextId(), path: s.path }))
        },
        addScripts(scripts) {
          ops.push({ type: 'addScripts', args: { scripts }, id: '' })
          return scripts.map((s) => ({ id: nextId(), path: s.path }))
        },
      }
      recipe(tx)
    },
  }
}

// ---------------------------------------------------------------------------
// buildImportPlan — basic structure
// ---------------------------------------------------------------------------

describe('buildImportPlan — structure', () => {
  const fileMap = makeSampleFileMap()
  const currentSite = makeEmptySiteDocument()
  const plan = buildImportPlan({ fileMap, currentSite })

  it('produces one page per HTML file', () => {
    expect(plan.pages).toHaveLength(3)
  })

  it('produces style rules from linked CSS', () => {
    // main.css and theme.css should produce rules
    expect(plan.styleRules.length).toBeGreaterThan(0)
  })

  it('follows local CSS @import rules from linked stylesheets', () => {
    const encoder = new TextEncoder()
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="css/main.css">
    </head><body>
      <section class="hero imported-only">Food</section>
    </body></html>`
    const fileMap: FileMap = {
      files: {
        'index.html': { bytes: encoder.encode(html), mimeType: 'text/html' },
        'css/main.css': {
          bytes: encoder.encode(`@import "components/hero.css"; .imported-only { color: white; }`),
          mimeType: 'text/css',
        },
        'css/components/hero.css': {
          bytes: encoder.encode(`.hero { min-height: 640px; background-image: url('../img/hero.png'); }`),
          mimeType: 'text/css',
        },
        'css/img/hero.png': { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
      },
    }

    const p = buildImportPlan({ fileMap, currentSite })
    const hero = p.styleRules.find((r) => r.kind === 'class' && r.name === 'hero')

    expect(hero).toBeDefined()
    expect(hero!.styles.minHeight).toBe('640px')
    expect(hero!.styles.backgroundImage).toContain(`url('css/img/hero.png')`)
    expect(p.styleRuleSources[p.styleRules.indexOf(hero!)]).toBe('css/components/hero.css')
    expect(p.assets.some((asset) => asset.sourcePath === 'css/img/hero.png')).toBe(true)
    expect(p.unusedCss).not.toContain('css/components/hero.css')
  })

  it('folds a body <style> block into the plan as a per-page CSS source', () => {
    const html = `<!doctype html><html><head>
      <style>.promo { color: rgb(255, 99, 71); } a:hover { text-decoration: underline; }</style>
    </head><body><div class="promo">Sale</div></body></html>`
    const p = buildImportPlan({
      fileMap: makeSinglePageFileMap(html),
      currentSite: makeEmptySiteDocument(),
    })
    // The <style>'s class rule appears in the plan with its declarations.
    const promo = p.styleRules.find((r) => r.kind === 'class' && r.name === 'promo')
    expect(promo).toBeDefined()
    expect(promo!.styles.color).toContain('255')
    // The ambient selector is registered too — verbatim, no generated scoping.
    expect(p.styleRules.some((r) => r.kind === 'ambient' && r.selector === 'a:hover')).toBe(true)
    expect(p.pages[0].nodeFragment.body?.classIds ?? []).toEqual([])
    // The page node still carries the class NAME (linked to an id at commit time).
    const fragment = p.pages[0].nodeFragment
    const divNode = Object.values(fragment.nodes).find((n) => n.moduleId === 'base.container')
    expect(divNode?.classIds).toContain('promo')
  })

  it('collects image assets', () => {
    const sourcePaths = plan.assets.map((a) => a.sourcePath)
    expect(sourcePaths).toContain('images/hero.png')
    expect(sourcePaths).toContain('images/logo.png')
  })

  it('plan.assets contains only media files — HTML pages are excluded even when linked via anchor', () => {
    // INDEX_HTML has <a href="about.html">About us</a>.  about.html must NOT
    // appear in plan.assets because it is an HTML page, not a media asset.
    const sourcePaths = plan.assets.map((a) => a.sourcePath)
    expect(sourcePaths).not.toContain('index.html')
    expect(sourcePaths).not.toContain('about.html')
    expect(sourcePaths).not.toContain('contact.html')
    // CSS files must also be excluded
    expect(sourcePaths).not.toContain('styles/main.css')
    expect(sourcePaths).not.toContain('styles/theme.css')
    // Every asset must be an image or font (no web-document MIME types)
    for (const asset of plan.assets) {
      const isWebDoc =
        asset.mimeType.startsWith('text/html') ||
        asset.mimeType.startsWith('text/css') ||
        asset.mimeType.startsWith('text/javascript') ||
        asset.mimeType.startsWith('application/javascript')
      expect(isWebDoc).toBe(false)
    }
  })

  it('imports linked JS files as page-scoped site scripts', () => {
    expect(plan.scripts.map((s) => s.path)).toEqual(['scripts/vendor.js', 'scripts/app.js'])
    expect(plan.scripts.map((s) => s.format)).toEqual(['classic', 'module'])
    expect(plan.scripts.map((s) => s.pageSources)).toEqual([['index.html'], ['index.html']])
    expect(plan.scripts.map((s) => s.priority)).toEqual([100, 101])
    expect(plan.scripts.map((s) => s.path)).not.toContain('scripts/unused.js')
  })

  it('imports executable inline scripts before the linked scripts that follow them', () => {
    const html = `<!doctype html><html><body>
      <script>var duration='500',easing='swing';</script>
      <script src="scripts/app.js"></script>
      <script type="application/json">{"ignored": true}</script>
    </body></html>`
    const encoder = new TextEncoder()
    const p = buildImportPlan({
      fileMap: {
        files: {
          'index.html': { bytes: encoder.encode(html), mimeType: 'text/html' },
          'scripts/app.js': { bytes: encoder.encode('duration = parseInt(duration, 10);'), mimeType: 'text/javascript' },
        },
      },
      currentSite,
    })

    expect(p.scripts.map((s) => ({
      path: s.path,
      content: s.content,
      format: s.format,
      pageSources: s.pageSources,
      priority: s.priority,
    }))).toEqual([
      {
        path: 'index.html-inline-script-1.js',
        content: "var duration='500',easing='swing';",
        format: 'classic',
        pageSources: ['index.html'],
        priority: 100,
      },
      {
        path: 'scripts/app.js',
        content: 'duration = parseInt(duration, 10);',
        format: 'classic',
        pageSources: ['index.html'],
        priority: 101,
      },
    ])
  })

  it('keeps script-created CSS classes publishable as ambient rules when no imported node uses them', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>
      <div class="used-class">Visible content</div>
    </body></html>`
    const css = `
      .used-class { color: red; }
      .runtime-created { position: fixed; width: 10px; height: 10px; }
    `
    const p = buildImportPlan({
      fileMap: makeSinglePageFileMap(html, css),
      currentSite,
    })

    expect(p.styleRules.find((rule) => rule.selector === '.used-class')?.kind).toBe('class')
    expect(p.styleRules.find((rule) => rule.selector === '.runtime-created')?.kind).toBe('ambient')
    expect(p.conflicts.rules.some((conflict) => conflict.desiredName === 'runtime-created')).toBe(false)
  })

  it('preserves Bootstrap utility fragments as ambient rules even when nodes use them', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="css/bootstrap.css">
      <link rel="stylesheet" href="css/main.css">
    </head><body>
      <section class="row align-items-stretch custom-row">
        <div class="col-xl-3">Left</div>
      </section>
    </body></html>`
    const bootstrapCss = `
      .row { display: flex; flex-wrap: wrap; }
      .row > * { flex-shrink: 0; width: 100%; max-width: 100%; }
      .col-xl-3 { flex: 0 0 auto; width: 25%; }
    `
    const mainCss = `
      .row { --bs-gutter-x: 30px; }
      .align-items-stretch { align-items: stretch; }
      .custom-row { gap: 24px; }
    `
    const encoder = new TextEncoder()
    const p = buildImportPlan({
      fileMap: {
        files: {
          'index.html': { bytes: encoder.encode(html), mimeType: 'text/html' },
          'css/bootstrap.css': { bytes: encoder.encode(bootstrapCss), mimeType: 'text/css' },
          'css/main.css': { bytes: encoder.encode(mainCss), mimeType: 'text/css' },
        },
      },
      currentSite,
    })

    const rowRules = p.styleRules.filter((rule) => rule.selector === '.row')
    expect(rowRules).toHaveLength(2)
    expect(rowRules.every((rule) => rule.kind === 'ambient')).toBe(true)
    expect(p.styleRules.find((rule) => rule.selector === '.row > *')?.kind).toBe('ambient')
    expect(p.styleRules.find((rule) => rule.selector === '.col-xl-3')?.kind).toBe('ambient')
    expect(p.styleRules.find((rule) => rule.selector === '.align-items-stretch')?.kind).toBe('ambient')
    expect(p.styleRules.find((rule) => rule.selector === '.custom-row')?.kind).toBe('class')

    const rowNode = Object.values(p.pages[0].nodeFragment.nodes).find((node) =>
      node.classIds?.includes('row'),
    )
    expect(rowNode?.classIds).toEqual(['row', 'align-items-stretch', 'custom-row'])
    expect(rowNode?.classIds).not.toContain('row-2')
  })

  it('preserves source body metadata and treats body classes as used class rules', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>
      <body id="page-root" class="body-bg" data-theme="dark" style="background-image: url('./images/bg.png')">
        <main class="content">Visible content</main>
      </body>
    </html>`
    const css = `.body-bg { background-color: #151518; } .content { color: white; }`
    const encoder = new TextEncoder()
    const p = buildImportPlan({
      fileMap: {
        files: {
          'index.html': { bytes: encoder.encode(html), mimeType: 'text/html' },
          'style.css': { bytes: encoder.encode(css), mimeType: 'text/css' },
          'images/bg.png': { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' },
        },
      },
      currentSite,
    })

    const body = p.pages[0].nodeFragment.body
    expect(body?.classIds).toEqual(['body-bg'])
    expect(body?.props?.htmlAttributes).toEqual({
      'data-theme': 'dark',
      id: 'page-root',
    })
    expect(body?.inlineStyles?.backgroundImage).toBe("url('images/bg.png')")
    expect(p.styleRules.find((rule) => rule.selector === '.body-bg')?.kind).toBe('class')
  })

  it('has empty conflicts on a fresh site', () => {
    expect(plan.conflicts.pages).toHaveLength(0)
    expect(plan.conflicts.rules).toHaveLength(0)
  })

  it('detects unused CSS — CSS not linked by any page', () => {
    const withUnused: FileMap = {
      files: {
        ...fileMap.files,
        'styles/unused.css': { bytes: new TextEncoder().encode('.u { display: none }'), mimeType: 'text/css' },
      },
    }
    const p = buildImportPlan({ fileMap: withUnused, currentSite })
    expect(p.unusedCss).toContain('styles/unused.css')
  })

  it('extracts root font variables into font tokens', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Home</h1></body></html>`
    const css = `
      :root {
        --font-display: "Acme Grotesk", serif;
        --font-size-base: 16px;
      }
      h1 { font-family: var(--font-display); }
    `
    const p = buildImportPlan({
      fileMap: makeSinglePageFileMap(html, css),
      currentSite: makeEmptySiteDocument(),
    })

    expect(p.fontTokens).toEqual([
      {
        name: 'Display',
        variable: 'font-display',
        family: 'Acme Grotesk',
        fallback: 'serif',
      },
    ])
    const root = p.styleRules.find((rule) => rule.selector === ':root')
    expect(root?.styles).toEqual({ '--font-size-base': '16px' })
    expect(p.styleRules.find((rule) => rule.selector === 'h1')?.styles.fontFamily).toBe('var(--font-display)')
  })

  it('plans Google Fonts @import as installed font requests', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Home</h1></body></html>`
    const css = `
      @import url("https://fonts.googleapis.com/css2?family=Manrope:wght@200..800&family=Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800&display=swap");
      :root {
        --title-font: "Plus Jakarta Sans", serif;
        --body-font: "Manrope", sans-serif;
      }
      h1 { font-family: var(--title-font); }
    `
    const p = buildImportPlan({
      fileMap: makeSinglePageFileMap(html, css),
      currentSite: makeEmptySiteDocument(),
    })

    expect(p.googleFonts).toEqual([
      {
        family: 'Manrope',
        variants: ['200', '300', '400', '500', '600', '700', '800'],
        subsets: ['latin'],
      },
      {
        family: 'Plus Jakarta Sans',
        variants: [
          '200',
          '200italic',
          '300',
          '300italic',
          '400',
          '400italic',
          '500',
          '500italic',
          '600',
          '600italic',
          '700',
          '700italic',
          '800',
          '800italic',
        ],
        subsets: ['latin'],
      },
    ])
    expect('fontImportUrl' in p).toBe(false)
    expect(p.styleRules.find((rule) => rule.selector === ':root')?.styles).toMatchObject({
      '--title-font': '"Plus Jakarta Sans", serif',
      '--body-font': '"Manrope", sans-serif',
    })
  })
})

// ---------------------------------------------------------------------------
// buildImportPlan — slug derivation
// ---------------------------------------------------------------------------

describe('buildImportPlan — slug derivation', () => {
  it('derives correct slugs from HTML filenames', () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const slugs = plan.pages.map((p) => p.slug).sort()
    expect(slugs).toContain('index')
    expect(slugs).toContain('about')
    expect(slugs).toContain('contact')
  })

  it('preserves nested static-site paths instead of collapsing every index.html to home', () => {
    const encoder = new TextEncoder()
    const fileMap: FileMap = {
      files: {
        'index.html': { bytes: encoder.encode('<html><body>Home</body></html>'), mimeType: 'text/html' },
        'documentation/index.html': { bytes: encoder.encode('<html><body>Docs</body></html>'), mimeType: 'text/html' },
        'download-version/index.html': { bytes: encoder.encode('<html><body>Download</body></html>'), mimeType: 'text/html' },
        'guides/install/quick-start.html': { bytes: encoder.encode('<html><body>Quick start</body></html>'), mimeType: 'text/html' },
      },
    }

    const plan = buildImportPlan({ fileMap, currentSite: makeEmptySiteDocument() })
    const slugs = plan.pages.map((p) => p.slug).sort()

    expect(slugs).toEqual([
      'documentation',
      'download-version',
      'guides/install/quick-start',
      'index',
    ])
    expect(plan.conflicts.pages).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// buildImportPlan — conflict detection with existing site
// ---------------------------------------------------------------------------

describe('buildImportPlan — conflict detection', () => {
  it('detects slug collision with existing page', () => {
    // Create a site that has a page with slug 'about'
    const site = {
      ...makeEmptySiteDocument(),
      pages: [
        {
          id: 'about-id',
          title: 'About',
          slug: 'about',
          rootNodeId: 'r',
          nodes: { r: { id: 'r', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [], classIds: [] } },
        },
      ],
    }
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: site })
    const aboutConflict = plan.conflicts.pages.find((c) => c.desiredSlug === 'about')
    expect(aboutConflict).toBeDefined()
    expect(aboutConflict!.defaultResolution.resolvedSlug).toBe('about-2')
  })

  it('detects class rule name collision', () => {
    const site = makeMockSiteDocument() // has 'existing-class' rule
    // Temporarily add a 'page-title' rule (present as an assigned class in our sample CSS)
    const now = Date.now()
    const siteWithPageTitle = {
      ...site,
      styleRules: {
        ...site.styleRules,
        'page-title-rule': {
          id: 'page-title-rule',
          name: 'page-title',
          kind: 'class' as const,
          selector: '.page-title',
          order: 2,
          styles: {},
          contextStyles: {},
          createdAt: now,
          updatedAt: now,
        },
      },
    }
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: siteWithPageTitle })
    const pageTitleConflict = plan.conflicts.rules.find((c) => c.desiredName === 'page-title')
    expect(pageTitleConflict).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// commitImportPlan — happy path
// ---------------------------------------------------------------------------

describe('commitImportPlan — happy path', () => {
  it('uploads all assets', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter()
    await commitImportPlan(plan, adapter)
    // hero.png and logo.png should be uploaded
    expect(adapter.uploads).toContain('images/hero.png')
    expect(adapter.uploads).toContain('images/logo.png')
  })

  it('calls addPage for each non-conflicting page', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter()
    await commitImportPlan(plan, adapter)
    const addPageOps = adapter.ops.filter((o) => o.type === 'addPage')
    expect(addPageOps).toHaveLength(3)
  })

  it('calls addStyleRule for each non-conflicting rule', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter()
    await commitImportPlan(plan, adapter)
    const addRuleOps = adapter.ops.filter((o) => o.type === 'addStyleRule')
    expect(addRuleOps.length).toBeGreaterThan(0)
  })

  it('commits linked scripts with resolved page scope', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter()
    await commitImportPlan(plan, adapter)

    const addPageOps = adapter.ops.filter((o) => o.type === 'addPage')
    const indexPageId = (addPageOps.find((op) => (op.args as { title: string }).title === 'Home Page')?.args as { id?: string } | undefined)?.id
    const addScriptsOp = adapter.ops.find((o) => o.type === 'addScripts')
    expect(indexPageId).toBeDefined()
    expect(addScriptsOp).toBeDefined()
    const scripts = (addScriptsOp!.args as { scripts: Array<{
      path: string
      format: string
      pageIds?: string[]
      priority: number
    }> }).scripts
    expect(scripts.map((script) => ({
      path: script.path,
      format: script.format,
      pageIds: script.pageIds,
      priority: script.priority,
    }))).toEqual([
      { path: 'scripts/vendor.js', format: 'classic', pageIds: [indexPageId], priority: 100 },
      { path: 'scripts/app.js', format: 'module', pageIds: [indexPageId], priority: 101 },
    ])
  })

  it('commits kept stylesheets (mode: file) with resolved page scope and rewritten asset URLs', async () => {
    const encoder = new TextEncoder()
    const html = `<!doctype html><html><head><link rel="stylesheet" href="css/style.css"></head><body><div class="cell">Hi</div></body></html>`
    const plan = buildImportPlan({
      fileMap: {
        files: {
          'index.html': { bytes: encoder.encode(html), mimeType: 'text/html' },
          'css/style.css': {
            bytes: encoder.encode(`.cell { color: red; background-image: url('../img/bg.png'); }`),
            mimeType: 'text/css',
          },
          'img/bg.png': { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
        },
      },
      currentSite: makeEmptySiteDocument(),
      options: { stylesheetModes: { 'css/style.css': 'file' } },
    })
    const adapter = makeMockAdapter()
    const result = await commitImportPlan(plan, adapter)

    const addPageOp = adapter.ops.find((o) => o.type === 'addPage')
    const pageId = (addPageOp?.args as { id?: string } | undefined)?.id
    const addStylesheetsOp = adapter.ops.find((o) => o.type === 'addStylesheets')
    expect(addStylesheetsOp).toBeDefined()
    const stylesheets = (addStylesheetsOp!.args as { stylesheets: Array<{
      path: string
      content: string
      pageIds?: string[]
      priority: number
    }> }).stylesheets
    expect(stylesheets).toHaveLength(1)
    expect(stylesheets[0].path).toBe('css/style.css')
    expect(stylesheets[0].content).toContain('color: red')
    // The kept file's url() payload points at the uploaded media URL, not the
    // FileMap key — applyAssetRewrites covers stylesheet text too.
    expect(stylesheets[0].content).toContain(`url('/uploads/media/img_bg.png')`)
    expect(stylesheets[0].pageIds).toEqual([pageId])
    expect(result.stylesheets).toHaveLength(1)
  })

  it('commits imported Google Fonts through installed font entries before font tokens', async () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Home</h1></body></html>`
    const fontUrl = 'https://fonts.googleapis.com/css2?family=Manrope:wght@200..800&display=swap'
    const css = `
      @import url("${fontUrl}");
      :root { --font-body: "Manrope", sans-serif; }
      h1 { font-family: var(--font-body); }
    `
    const plan = buildImportPlan({
      fileMap: makeSinglePageFileMap(html, css),
      currentSite: makeEmptySiteDocument(),
    })
    const adapter = makeMockAdapter()
    const result = await commitImportPlan(plan, adapter)

    expect(adapter.installs).toEqual([
      {
        family: 'Manrope',
        variants: ['200', '300', '400', '500', '600', '700', '800'],
        subsets: ['latin'],
      },
    ])
    expect(adapter.ops.map((o) => o.type)).toContain('addInstalledFonts')
    expect(adapter.ops.findIndex((o) => o.type === 'addInstalledFonts')).toBeLessThan(
      adapter.ops.findIndex((o) => o.type === 'addFontTokens'),
    )
    expect(result.fonts).toEqual([{ id: 'font-manrope', family: 'Manrope' }])
    expect('fontImportUrl' in result).toBe(false)
  })

  it('returns ImportResult with correct shape', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter()
    const result = await commitImportPlan(plan, adapter)
    expect(result.pages).toHaveLength(3)
    expect(result.styleRules.length).toBeGreaterThan(0)
    expect(result.assets.length).toBeGreaterThan(0)
    // Each asset should have a mediaUrl
    for (const asset of result.assets) {
      expect(asset.mediaUrl.startsWith('/uploads/media/')).toBe(true)
    }
  })

  it('commits imported font tokens after imported font families', async () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Home</h1></body></html>`
    const css = `
      @font-face {
        font-family: "Acme Grotesk";
        font-weight: 400;
        font-style: normal;
        src: url("fonts/acme.woff2") format("woff2");
      }
      :root { --font-display: "Acme Grotesk", serif; }
      h1 { font-family: var(--font-display); }
    `
    const plan = buildImportPlan({
      fileMap: {
        files: {
          ...makeSinglePageFileMap(html, css).files,
          'fonts/acme.woff2': { bytes: new Uint8Array([1, 2, 3]), mimeType: 'font/woff2' },
        },
      },
      currentSite: makeEmptySiteDocument(),
    })
    const adapter = makeMockAdapter()
    const result = await commitImportPlan(plan, adapter)

    const addFontsIndex = adapter.ops.findIndex((op) => op.type === 'addFonts')
    const addFontTokensIndex = adapter.ops.findIndex((op) => op.type === 'addFontTokens')
    expect(addFontsIndex).toBeGreaterThanOrEqual(0)
    expect(addFontTokensIndex).toBeGreaterThan(addFontsIndex)
    expect((adapter.ops[addFontTokensIndex].args as { tokens: unknown[] }).tokens).toEqual([
      {
        name: 'Display',
        variable: 'font-display',
        family: 'Acme Grotesk',
        fallback: 'serif',
      },
    ])
    expect(result.fontTokens).toEqual([
      { id: 'mock-id-2', name: 'Display', variable: 'font-display' },
    ])
  })

  it('rewrites asset URLs in the committed pages', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter()
    await commitImportPlan(plan, adapter)

    // Find addPage ops and inspect their nodeFragment for rewritten URLs
    const addPageOps = adapter.ops.filter((o) => o.type === 'addPage')
    let foundRewrittenSrc = false
    for (const op of addPageOps) {
      const fragment = (op.args as { nodeFragment: ImportFragment }).nodeFragment
      for (const node of Object.values(fragment.nodes)) {
        const src = node.props['src']
        if (typeof src === 'string' && src.startsWith('/uploads/media/')) {
          foundRewrittenSrc = true
        }
      }
    }
    expect(foundRewrittenSrc).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// commitImportPlan — conflict resolution branches
// ---------------------------------------------------------------------------

describe('commitImportPlan — conflict: skip', () => {
  it('skips a page when resolution is "skip"', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    // Manually inject a conflict with skip resolution
    const pageToSkip = plan.pages[0]
    const planWithConflict: ImportPlan = {
      ...plan,
      conflicts: {
        ...plan.conflicts,
        pages: [
          {
            source: pageToSkip.source,
            desiredSlug: pageToSkip.slug,
            existingPageId: 'existing-id',
            defaultResolution: { action: 'skip' },
          },
        ],
      },
    }
    const adapter = makeMockAdapter()
    const result = await commitImportPlan(planWithConflict, adapter)

    // The skipped page should not appear in addPage ops
    const addPageOps = adapter.ops.filter((o) => o.type === 'addPage')
    expect(addPageOps).toHaveLength(plan.pages.length - 1)
    // Should not appear in result.pages
    expect(result.pages.find((p) => p.source === pageToSkip.source)).toBeUndefined()
  })
})

describe('commitImportPlan — conflict: overwrite', () => {
  it('calls overwritePage when resolution is "overwrite"', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const pageToOverwrite = plan.pages[0]
    const planWithConflict: ImportPlan = {
      ...plan,
      conflicts: {
        ...plan.conflicts,
        pages: [
          {
            source: pageToOverwrite.source,
            desiredSlug: pageToOverwrite.slug,
            existingPageId: 'old-page-id',
            defaultResolution: { action: 'overwrite' },
          },
        ],
      },
    }
    const adapter = makeMockAdapter()
    await commitImportPlan(planWithConflict, adapter)
    const overwriteOps = adapter.ops.filter((o) => o.type === 'overwritePage')
    expect(overwriteOps).toHaveLength(1)
    expect((overwriteOps[0].args as Record<string, unknown>)['pageId']).toBe('old-page-id')
  })
})

describe('commitImportPlan — conflict: auto-rename', () => {
  it('uses resolvedSlug when resolution is "auto-rename"', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const pageToRename = plan.pages[0]
    const planWithConflict: ImportPlan = {
      ...plan,
      pages: plan.pages.map((p) =>
        p.source === pageToRename.source ? { ...p, slug: 'about-2' } : p,
      ),
      conflicts: {
        ...plan.conflicts,
        pages: [
          {
            source: pageToRename.source,
            desiredSlug: pageToRename.slug,
            existingPageId: 'old-page-id',
            defaultResolution: { action: 'auto-rename', resolvedSlug: 'about-2' },
          },
        ],
      },
    }
    const adapter = makeMockAdapter()
    await commitImportPlan(planWithConflict, adapter)
    const addOps = adapter.ops.filter(
      (o) => o.type === 'addPage' && (o.args as Record<string, unknown>)['slug'] === 'about-2',
    )
    expect(addOps.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Atomicity — forced upload failure leaves no partial store state
// ---------------------------------------------------------------------------

describe('commitImportPlan — per-asset upload failure recovery', () => {
  it('continues past upload failures, records them as warnings, and still commits the store mutation', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const adapter = makeMockAdapter({ uploadFail: true })

    // Per-asset failures used to throw and abort the whole commit. The new
    // contract: catch each failure, surface it as an `asset-upload-failed`
    // warning, continue uploading the rest, and still run `adapter.commit`
    // so the user's pages + style rules land regardless.
    const result = await commitImportPlan(plan, adapter)

    expect(adapter.ops.length).toBeGreaterThan(0) // commit DID run
    expect(result.assets).toEqual([]) // all uploads failed → no successful assets
    const uploadFailures = result.warnings.filter((w) => w.kind === 'asset-upload-failed')
    expect(uploadFailures.length).toBe(plan.assets.length)
  })
})

// ---------------------------------------------------------------------------
// Unused CSS
// ---------------------------------------------------------------------------

describe('buildImportPlan — unused CSS', () => {
  it('marks CSS files not linked by any page as unusedCss', () => {
    const enc = new TextEncoder()
    const fileMapWithOrphan: FileMap = {
      files: {
        'index.html': { bytes: enc.encode('<html><head></head><body><p>Hi</p></body></html>'), mimeType: 'text/html' },
        'styles/orphan.css': { bytes: enc.encode('.foo { color: red }'), mimeType: 'text/css' },
      },
    }
    const plan = buildImportPlan({ fileMap: fileMapWithOrphan, currentSite: makeEmptySiteDocument() })
    expect(plan.unusedCss).toContain('styles/orphan.css')
    // orphan CSS rules should NOT appear in styleRules
    expect(plan.styleRules.find((r) => r.name === 'foo')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Token conflicts at commit (overwrite routing)
// ---------------------------------------------------------------------------

describe('commitImportPlan — token conflict: overwrite', () => {
  it('routes an overwrite colour token to overwriteColorTokens, not addColorTokens', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const planWithToken: ImportPlan = {
      ...plan,
      colors: [{ slug: 'bg', value: '#123456' }],
      conflicts: {
        ...plan.conflicts,
        tokens: [
          {
            kind: 'color',
            desiredVariable: 'bg',
            existingTokenId: 'existing-color-id',
            defaultResolution: { action: 'overwrite' },
          },
        ],
      },
    }
    const adapter = makeMockAdapter()
    await commitImportPlan(planWithToken, adapter)

    const overwrite = adapter.ops.find((o) => o.type === 'overwriteColorTokens')
    expect(overwrite).toBeDefined()
    expect((overwrite!.args as { items: unknown[] }).items).toEqual([
      { existingTokenId: 'existing-color-id', value: '#123456' },
    ])
    // The bg token must NOT be double-added.
    expect(adapter.ops.some((o) => o.type === 'addColorTokens')).toBe(false)
  })

  it('routes an overwrite font token to overwriteFontTokens, not addFontTokens', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const fontToken = { name: 'Primary', variable: 'font-primary', fallback: 'sans-serif' }
    const planWithToken: ImportPlan = {
      ...plan,
      fontTokens: [fontToken],
      conflicts: {
        ...plan.conflicts,
        tokens: [
          {
            kind: 'font',
            desiredVariable: 'font-primary',
            existingTokenId: 'existing-font-id',
            defaultResolution: { action: 'overwrite' },
          },
        ],
      },
    }
    const adapter = makeMockAdapter()
    await commitImportPlan(planWithToken, adapter)

    const overwrite = adapter.ops.find((o) => o.type === 'overwriteFontTokens')
    expect(overwrite).toBeDefined()
    expect((overwrite!.args as { items: { existingTokenId: string }[] }).items[0].existingTokenId).toBe(
      'existing-font-id',
    )
    expect(adapter.ops.some((o) => o.type === 'addFontTokens')).toBe(false)
  })

  it('adds a non-conflicting colour token via addColorTokens', async () => {
    const plan = buildImportPlan({ fileMap: makeSampleFileMap(), currentSite: makeEmptySiteDocument() })
    const planWithToken: ImportPlan = {
      ...plan,
      colors: [{ slug: 'brand', value: '#abcdef' }],
      conflicts: { ...plan.conflicts, tokens: [] },
    }
    const adapter = makeMockAdapter()
    await commitImportPlan(planWithToken, adapter)

    expect(adapter.ops.some((o) => o.type === 'addColorTokens')).toBe(true)
    expect(adapter.ops.some((o) => o.type === 'overwriteColorTokens')).toBe(false)
  })
})
