/**
 * Per-stylesheet import modes + cross-sheet class semantics.
 *
 * Covers the model that replaced the automatic `instatic-import-scope-*`
 * generation:
 *   - `mode: 'file'` keeps a stylesheet verbatim as an ImportStylesheet
 *     (flattened @import graph, Google imports stripped, url() normalised),
 *     skipping all semantic extraction for it.
 *   - Converted sheets merge CSS-natively; DIVERGENT cross-sheet class
 *     definitions surface as explicit `crossSheetClasses` conflicts whose
 *     resolutions (rename / keep-first / overwrite) apply through
 *     `applyConflictResolutions`.
 *   - The registry's unique-class-name invariant is enforced by demoting
 *     repeated class fragments to ambient rules after renames.
 */

import { describe, it, expect } from 'bun:test'
import '@modules/base'
import { buildImportPlan, applyConflictResolutions } from '@core/siteImport'
import type { FileMap, ImportPlan } from '@core/siteImport'
import { makeEmptySiteDocument } from './mockSite'

const encoder = new TextEncoder()

function twoPageFileMap(cssA: string, cssB: string): FileMap {
  const pageHtml = (cssHref: string) => `<!doctype html><html><head>
    <link rel="stylesheet" href="${cssHref}">
  </head><body>
    <a class="btn" href="#">Buy</a>
  </body></html>`
  return {
    files: {
      'index.html': { bytes: encoder.encode(pageHtml('css/a.css')), mimeType: 'text/html' },
      'original.html': { bytes: encoder.encode(pageHtml('css/b.css')), mimeType: 'text/html' },
      'css/a.css': { bytes: encoder.encode(cssA), mimeType: 'text/css' },
      'css/b.css': { bytes: encoder.encode(cssB), mimeType: 'text/css' },
    },
  }
}

function resolveWithDefaults(plan: ImportPlan): ImportPlan {
  return applyConflictResolutions(
    plan,
    plan.conflicts.pages,
    plan.conflicts.rules,
    plan.conflicts.tokens,
    plan.conflicts.crossSheetClasses,
  )
}

// ---------------------------------------------------------------------------
// Cross-sheet class conflicts (converted sheets)
// ---------------------------------------------------------------------------

describe('cross-sheet class conflicts', () => {
  it('flags divergent definitions and renames the later one by default', () => {
    const plan = buildImportPlan({
      fileMap: twoPageFileMap(
        '.btn { border-radius: 0; } .btn:hover { opacity: 0.9; }',
        '.btn { border-radius: 999px; } .btn:hover { opacity: 0.5; }',
      ),
      currentSite: makeEmptySiteDocument(),
    })

    expect(plan.conflicts.crossSheetClasses).toHaveLength(1)
    const conflict = plan.conflicts.crossSheetClasses[0]
    expect(conflict.desiredName).toBe('btn')
    expect(conflict.pageSources).toEqual(['original.html'])
    expect(conflict.sources).toEqual(['css/b.css'])
    expect(conflict.defaultResolution).toEqual({ action: 'auto-rename', resolvedName: 'btn-2' })

    const resolved = resolveWithDefaults(plan)

    // The kept definition owns the bare name; the renamed one is materialised.
    const classRules = resolved.styleRules.filter((r) => r.kind === 'class')
    expect(classRules.map((r) => r.name).sort()).toEqual(['btn', 'btn-2'])
    expect(classRules.find((r) => r.name === 'btn')?.styles.borderTopLeftRadius).toBe('0px')
    expect(classRules.find((r) => r.name === 'btn-2')?.styles.borderTopLeftRadius).toBe('999px')

    // The renamed cascade's ambient selectors and node tokens follow.
    const hoverSelectors = resolved.styleRules
      .filter((r) => r.kind === 'ambient')
      .map((r) => r.selector)
      .sort()
    expect(hoverSelectors).toEqual(['.btn-2:hover', '.btn:hover'])

    const pageA = resolved.pages.find((p) => p.source === 'index.html')!
    const pageB = resolved.pages.find((p) => p.source === 'original.html')!
    const tokensOf = (page: typeof pageA) =>
      Object.values(page.nodeFragment.nodes).flatMap((n) => n.classIds ?? [])
    expect(tokensOf(pageA)).toContain('btn')
    expect(tokensOf(pageB)).toContain('btn-2')
    expect(tokensOf(pageB)).not.toContain('btn')
  })

  it('does not flag identical definitions', () => {
    const plan = buildImportPlan({
      fileMap: twoPageFileMap(
        '.btn { border-radius: 4px; }',
        '.btn { border-radius: 4px; }',
      ),
      currentSite: makeEmptySiteDocument(),
    })

    expect(plan.conflicts.crossSheetClasses).toHaveLength(0)

    // The duplicate fragment demotes to an ambient rule — one bindable class.
    const resolved = resolveWithDefaults(plan)
    const btnClassRules = resolved.styleRules.filter((r) => r.kind === 'class' && r.name === 'btn')
    expect(btnClassRules).toHaveLength(1)
  })

  it('keep-first (skip) drops the divergent definition and binds its pages to the first', () => {
    const plan = buildImportPlan({
      fileMap: twoPageFileMap(
        '.btn { border-radius: 0; }',
        '.btn { border-radius: 999px; }',
      ),
      currentSite: makeEmptySiteDocument(),
    })
    const conflict = plan.conflicts.crossSheetClasses[0]

    const resolved = applyConflictResolutions(plan, [], [], [], [
      { ...conflict, defaultResolution: { action: 'skip' } },
    ])

    const btnRules = resolved.styleRules.filter((r) =>
      (r.kind === 'class' && r.name === 'btn') || (r.kind === 'ambient' && r.selector === '.btn'),
    )
    expect(btnRules).toHaveLength(1)
    expect(btnRules[0].styles.borderTopLeftRadius).toBe('0px')

    const pageB = resolved.pages.find((p) => p.source === 'original.html')!
    const tokens = Object.values(pageB.nodeFragment.nodes).flatMap((n) => n.classIds ?? [])
    expect(tokens).toContain('btn')
  })

  it('overwrite makes the divergent definition win the bare name', () => {
    const plan = buildImportPlan({
      fileMap: twoPageFileMap(
        '.btn { border-radius: 0; }',
        '.btn { border-radius: 999px; }',
      ),
      currentSite: makeEmptySiteDocument(),
    })
    const conflict = plan.conflicts.crossSheetClasses[0]

    const resolved = applyConflictResolutions(plan, [], [], [], [
      { ...conflict, defaultResolution: { action: 'overwrite' } },
    ])

    const btnRules = resolved.styleRules.filter((r) =>
      (r.kind === 'class' && r.name === 'btn') || (r.kind === 'ambient' && r.selector === '.btn'),
    )
    expect(btnRules).toHaveLength(1)
    expect(btnRules[0].styles.borderTopLeftRadius).toBe('999px')
  })

  it('reserves rename suffixes against existing site class names', () => {
    const site = makeEmptySiteDocument()
    site.styleRules['existing'] = {
      id: 'existing',
      name: 'btn-2',
      kind: 'class',
      selector: '.btn-2',
      order: 0,
      styles: {},
      contextStyles: {},
      createdAt: 0,
      updatedAt: 0,
    }
    const plan = buildImportPlan({
      fileMap: twoPageFileMap(
        '.btn { color: red; }',
        '.btn { color: blue; }',
      ),
      currentSite: site,
    })

    expect(plan.conflicts.crossSheetClasses[0].defaultResolution.resolvedName).toBe('btn-3')
  })
})

// ---------------------------------------------------------------------------
// Keep-as-stylesheet mode
// ---------------------------------------------------------------------------

describe('stylesheet mode: file', () => {
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="css/style.css">
  </head><body>
    <div class="spec-cell">Cell</div>
  </body></html>`

  function fileModeMap(css: string, extra: FileMap['files'] = {}): FileMap {
    return {
      files: {
        'index.html': { bytes: encoder.encode(html), mimeType: 'text/html' },
        'css/style.css': { bytes: encoder.encode(css), mimeType: 'text/css' },
        ...extra,
      },
    }
  }

  it('keeps the sheet verbatim and skips all semantic extraction', () => {
    const css = `:root { --bg: #101014; }\n.spec-cell { color: var(--bg); }\n* { box-sizing: border-box; }`
    const plan = buildImportPlan({
      fileMap: fileModeMap(css),
      currentSite: makeEmptySiteDocument(),
      options: { stylesheetModes: { 'css/style.css': 'file' } },
    })

    expect(plan.linkedStylesheets).toEqual([
      { path: 'css/style.css', mode: 'file', pageSources: ['index.html'] },
    ])
    expect(plan.stylesheets).toHaveLength(1)
    expect(plan.stylesheets[0].path).toBe('css/style.css')
    expect(plan.stylesheets[0].pageSources).toEqual(['index.html'])
    // Verbatim: no rules, no tokens, no scope classes — the file is the truth.
    expect(plan.stylesheets[0].content).toContain('.spec-cell { color: var(--bg); }')
    expect(plan.styleRules).toHaveLength(0)
    expect(plan.colors).toHaveLength(0)
    expect(plan.conflicts.crossSheetClasses).toHaveLength(0)
    // The page no longer treats the sheet as a converted cascade…
    expect(plan.pages[0].linkedCssPaths).toEqual([])
    // …but the sheet is used, not "unused CSS".
    expect(plan.unusedCss).toHaveLength(0)
    // Node class tokens stay — commit auto-creates bare classes for them.
    const tokens = Object.values(plan.pages[0].nodeFragment.nodes).flatMap((n) => n.classIds ?? [])
    expect(tokens).toContain('spec-cell')
  })

  it('normalises url() payloads to FileMap keys and registers the assets', () => {
    const css = `.hero { background-image: url('../img/bg.png'); }`
    const plan = buildImportPlan({
      fileMap: fileModeMap(css, {
        'img/bg.png': { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
      }),
      currentSite: makeEmptySiteDocument(),
      options: { stylesheetModes: { 'css/style.css': 'file' } },
    })

    expect(plan.stylesheets[0].content).toContain(`url('img/bg.png')`)
    expect(plan.assets.some((a) => a.sourcePath === 'img/bg.png')).toBe(true)
  })

  it('flattens the local @import graph in cascade order and strips Google imports', () => {
    const css = `@import url("https://fonts.googleapis.com/css2?family=Manrope:wght@400&display=swap");\n@import "base.css";\n.spec-cell { color: red; }`
    const plan = buildImportPlan({
      fileMap: fileModeMap(css, {
        'css/base.css': { bytes: encoder.encode('body { margin: 0; }'), mimeType: 'text/css' },
      }),
      currentSite: makeEmptySiteDocument(),
      options: { stylesheetModes: { 'css/style.css': 'file' } },
    })

    const content = plan.stylesheets[0].content
    // Imported file's text lands BEFORE the importer's own rules.
    expect(content.indexOf('margin: 0')).toBeLessThan(content.indexOf('.spec-cell'))
    expect(content).not.toContain('@import')
    expect(plan.googleFonts.map((f) => f.family)).toEqual(['Manrope'])
    expect(plan.unusedCss).toHaveLength(0)
  })

  it('converted sheets are unaffected by another sheet being kept', () => {
    const pageTwo = `<!doctype html><html><head>
      <link rel="stylesheet" href="css/other.css">
    </head><body><p class="lead">Hi</p></body></html>`
    const plan = buildImportPlan({
      fileMap: fileModeMap('.spec-cell { color: red; }', {
        'two.html': { bytes: encoder.encode(pageTwo), mimeType: 'text/html' },
        'css/other.css': { bytes: encoder.encode('.lead { font-size: 18px; }'), mimeType: 'text/css' },
      }),
      currentSite: makeEmptySiteDocument(),
      options: { stylesheetModes: { 'css/style.css': 'file' } },
    })

    expect(plan.stylesheets.map((s) => s.path)).toEqual(['css/style.css'])
    expect(plan.styleRules.some((r) => r.kind === 'class' && r.name === 'lead')).toBe(true)
    expect(plan.styleRules.some((r) => r.name === 'spec-cell')).toBe(false)
    expect(plan.linkedStylesheets).toEqual([
      { path: 'css/style.css', mode: 'file', pageSources: ['index.html'] },
      { path: 'css/other.css', mode: 'convert', pageSources: ['two.html'] },
    ])
  })
})
