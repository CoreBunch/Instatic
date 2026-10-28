/**
 * Unit tests for conflicts — slug and rule-name collision detection.
 */

import { describe, it, expect } from 'bun:test'
import { detectConflicts, applyConflictResolutions, buildImportPlan } from '@core/siteImport'
import { makeSinglePageFileMap } from './fixtures'
import type {
  ImportPlan,
  PagePlan,
  NewStyleRule,
  ConflictResolution,
  PageConflict,
  RuleConflict,
  TokenConflict,
  ImportColorToken,
  ImportFontToken,
} from '@core/siteImport'
import type { SiteDocument } from '@core/page-tree'
import { makeMockSiteDocument } from './mockSite'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyFragment() {
  return { rootIds: [], nodes: {} }
}

function makePage(slug: string, source = ''): PagePlan {
  return {
    source: source || `${slug}.html`,
    title: slug,
    slug,
    linkedCssPaths: [],
    scripts: [],
    nodeFragment: emptyFragment(),
  }
}

function makeClassRule(name: string): NewStyleRule {
  return {
    name,
    kind: 'class',
    selector: `.${name}`,
    order: 0,
    styles: {},
    contextStyles: {},
  }
}

function makeAmbientRule(selector: string): NewStyleRule {
  return {
    name: selector,
    kind: 'ambient',
    selector,
    order: 0,
    styles: {},
    contextStyles: {},
  }
}

const MOCK_SITE = makeMockSiteDocument()

// ---------------------------------------------------------------------------
// Page conflict detection
// ---------------------------------------------------------------------------

describe('detectConflicts — page slugs', () => {
  it('detects a slug collision with an existing page', () => {
    const { pages } = detectConflicts(MOCK_SITE, [makePage('existing')], [])
    expect(pages).toHaveLength(1)
    expect(pages[0].desiredSlug).toBe('existing')
    expect(pages[0].existingPageId).toBe('existing-page-id')
  })

  it('defaults to auto-rename resolution', () => {
    const { pages } = detectConflicts(MOCK_SITE, [makePage('existing')], [])
    expect(pages[0].defaultResolution.action).toBe('auto-rename')
    expect(pages[0].defaultResolution.resolvedSlug).toBe('existing-2')
  })

  it('increments suffix if -2 is also taken', () => {
    // Add existing page with slug 'existing-2' too
    const siteWithTwo = {
      ...MOCK_SITE,
      pages: [
        ...MOCK_SITE.pages,
        {
          id: 'page-2-id',
          title: 'Existing 2',
          slug: 'existing-2',
          rootNodeId: 'r',
          nodes: { r: { id: 'r', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [], classIds: [] } },
        },
      ],
    }
    const { pages } = detectConflicts(siteWithTwo, [makePage('existing')], [])
    expect(pages[0].defaultResolution.resolvedSlug).toBe('existing-3')
  })

  it('reports no conflicts when slug is unique', () => {
    const { pages } = detectConflicts(MOCK_SITE, [makePage('brand-new')], [])
    expect(pages).toHaveLength(0)
  })

  it('detects intra-batch slug collision between two imported pages', () => {
    // Two HTML files that both derive to the same slug
    const plan1 = makePage('about', 'about.html')
    const plan2 = makePage('about', 'about-copy.html')
    const { pages } = detectConflicts(MOCK_SITE, [plan1, plan2], [])
    // The second 'about' should conflict
    expect(pages.some((c) => c.source === 'about-copy.html')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Rule conflict detection
// ---------------------------------------------------------------------------

describe('detectConflicts — class rule names', () => {
  it('detects a class name collision with an existing rule', () => {
    const { rules } = detectConflicts(MOCK_SITE, [], [makeClassRule('existing-class')])
    expect(rules).toHaveLength(1)
    expect(rules[0].desiredName).toBe('existing-class')
    expect(rules[0].existingRuleId).toBe('existing-rule-id')
  })

  it('defaults to auto-rename for class conflicts', () => {
    const { rules } = detectConflicts(MOCK_SITE, [], [makeClassRule('existing-class')])
    expect(rules[0].defaultResolution.action).toBe('auto-rename')
    expect(rules[0].defaultResolution.resolvedName).toBe('existing-class-2')
  })

  it('ambient rules NEVER conflict (even with same selector as existing)', () => {
    // 'h1' ambient rule exists in MOCK_SITE
    const { rules } = detectConflicts(MOCK_SITE, [], [makeAmbientRule('h1')])
    expect(rules).toHaveLength(0)
  })

  it('reports no conflict when class name is unique', () => {
    const { rules } = detectConflicts(MOCK_SITE, [], [makeClassRule('brand-new-class')])
    expect(rules).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// applyConflictResolutions
// ---------------------------------------------------------------------------

describe('applyConflictResolutions', () => {
  function makePlan(pages: PagePlan[], styleRules: NewStyleRule[]): ImportPlan {
    return {
      pages,
      styleRules,
      styleRuleSources: styleRules.map(() => 'styles.css'),
      assets: [],
      fonts: [],
      googleFonts: [],
      conditions: [],
      conflicts: { pages: [], rules: [], tokens: [] },
      warnings: [],
      colors: [],
      fontTokens: [],
      scripts: [],
      droppedAtRules: [],
      unusedCss: [],
    }
  }

  it('auto-rename: applies resolvedSlug to the matching page', () => {
    const page = makePage('existing', 'existing.html')
    const plan = makePlan([page], [])
    const res: PageConflict = {
      source: 'existing.html',
      desiredSlug: 'existing',
      existingPageId: 'existing-page-id',
      defaultResolution: { action: 'auto-rename', resolvedSlug: 'existing-2' },
    }
    const result = applyConflictResolutions(plan, [res], [])
    expect(result.pages[0].slug).toBe('existing-2')
  })

  it('skip: page remains with original slug (not applied at plan-apply level)', () => {
    const page = makePage('existing', 'existing.html')
    const plan = makePlan([page], [])
    const res: PageConflict = {
      source: 'existing.html',
      desiredSlug: 'existing',
      existingPageId: 'existing-page-id',
      defaultResolution: { action: 'skip' },
    }
    const result = applyConflictResolutions(plan, [res], [])
    // The plan slug stays; commitImportPlan skips the page based on resolution.action
    expect(result.pages[0].slug).toBe('existing')
  })

  it('auto-rename rule: applies resolvedName and updates selector', () => {
    const rule = makeClassRule('existing-class')
    const plan = makePlan([], [rule])
    const res: RuleConflict = {
      source: '',
      desiredName: 'existing-class',
      existingRuleId: 'existing-rule-id',
      defaultResolution: { action: 'auto-rename', resolvedName: 'existing-class-2' },
    }
    const result = applyConflictResolutions(plan, [], [res])
    expect(result.styleRules[0].name).toBe('existing-class-2')
    expect(result.styleRules[0].selector).toBe('.existing-class-2')
  })

  it('auto-rename rule: remaps node classIds that referenced the renamed class', () => {
    // A page fragment whose node carries the class NAME `btn` (walkAndMap copies
    // el.classList verbatim; names become ids only at commit). The imported `.btn`
    // rule conflicts with a pre-existing `.btn` and is auto-renamed to `.btn-2`.
    // Regression: the node's classIds must follow the rename — otherwise it binds
    // to the pre-existing same-named rule at commit and the imported styles strand
    // in an orphaned `.btn-2`.
    const page: PagePlan = {
      source: 'index.html',
      title: 'Index',
      slug: 'index',
      linkedCssPaths: [],
      scripts: [],
      nodeFragment: {
        rootIds: ['btn-node'],
        nodes: {
          'btn-node': {
            id: 'btn-node',
            moduleId: 'base.button',
            props: { label: 'Go' },
            breakpointOverrides: {},
            children: [],
            classIds: ['btn'],
          },
          // A sibling node that does NOT reference btn — must be untouched.
          'other-node': {
            id: 'other-node',
            moduleId: 'base.text',
            props: { text: 'hi', tag: 'p' },
            breakpointOverrides: {},
            children: [],
            classIds: ['intro'],
          },
        },
      },
    }
    const rule = makeClassRule('btn')
    const plan = makePlan([page], [rule])
    const res: RuleConflict = {
      source: '',
      desiredName: 'btn',
      existingRuleId: 'preexisting-btn',
      defaultResolution: { action: 'auto-rename', resolvedName: 'btn-2' },
    }
    const result = applyConflictResolutions(plan, [], [res])

    // The rule is renamed…
    expect(result.styleRules[0].name).toBe('btn-2')
    expect(result.styleRules[0].selector).toBe('.btn-2')
    // …and the node that referenced it follows the rename.
    expect(result.pages[0].nodeFragment.nodes['btn-node'].classIds).toEqual(['btn-2'])
    // Unrelated class names are left alone.
    expect(result.pages[0].nodeFragment.nodes['other-node'].classIds).toEqual(['intro'])
  })

  it('auto-rename rule: remaps ambient selectors that reference the renamed class', () => {
    const plan = makePlan(
      [],
      [
        makeClassRule('btn'),
        makeAmbientRule('.btn:hover'),
        makeAmbientRule('.card .btn'),
      ],
    )
    const res: RuleConflict = {
      source: '',
      desiredName: 'btn',
      existingRuleId: 'preexisting-btn',
      defaultResolution: { action: 'auto-rename', resolvedName: 'btn-2' },
    }
    const result = applyConflictResolutions(plan, [], [res])

    expect(result.styleRules[0].selector).toBe('.btn-2')
    expect(result.styleRules[1].selector).toBe('.btn-2:hover')
    expect(result.styleRules[2].selector).toBe('.card .btn-2')
  })

  it('auto-rename preserves an escaped imported variant selector', () => {
    const variant: NewStyleRule = {
      ...makeClassRule('group-hover:block'),
      selector: '.group:hover .group-hover\\:block',
    }
    const plan = makePlan([], [variant])
    const res: RuleConflict = {
      source: '',
      desiredName: 'group-hover:block',
      existingRuleId: 'preexisting-variant',
      defaultResolution: {
        action: 'auto-rename',
        resolvedName: 'group-hover:block-2',
      },
    }

    const result = applyConflictResolutions(plan, [], [res])

    expect(result.styleRules[0]).toMatchObject({
      name: 'group-hover:block-2',
      selector: '.group:hover .group-hover\\:block-2',
    })
  })

  it('skip rule: node classIds keep the original name (binds to pre-existing rule)', () => {
    const page: PagePlan = {
      source: 'index.html',
      title: 'Index',
      slug: 'index',
      linkedCssPaths: [],
      scripts: [],
      nodeFragment: {
        rootIds: ['btn-node'],
        nodes: {
          'btn-node': {
            id: 'btn-node',
            moduleId: 'base.button',
            props: { label: 'Go' },
            breakpointOverrides: {},
            children: [],
            classIds: ['btn'],
          },
        },
      },
    }
    const rule = makeClassRule('btn')
    const plan = makePlan([page], [rule])
    const res: RuleConflict = {
      source: '',
      desiredName: 'btn',
      existingRuleId: 'preexisting-btn',
      defaultResolution: { action: 'skip' },
    }
    const result = applyConflictResolutions(plan, [], [res])
    // Skip intentionally keeps the original name so the node binds to the
    // pre-existing same-named rule at commit.
    expect(result.pages[0].nodeFragment.nodes['btn-node'].classIds).toEqual(['btn'])
  })

  it('ambient rules are unaffected by rule resolutions', () => {
    const rule = makeAmbientRule('h1')
    const plan = makePlan([], [rule])
    // Even if we pass a resolution for 'h1', ambient rules are skipped
    const res: RuleConflict = {
      source: '',
      desiredName: 'h1',
      existingRuleId: 'ambient-rule-id',
      defaultResolution: { action: 'auto-rename', resolvedName: 'h1-2' },
    }
    const result = applyConflictResolutions(plan, [], [res])
    // Ambient rule 'h1' should not match any resolution because
    // detectConflicts only produces RuleConflicts for class-kind rules.
    // The resolution by desiredName would match, but since the rule is ambient,
    // the selector rename would be incorrect — check that ambient rules keep their names.
    expect(result.styleRules[0].selector).toBe('h1') // unchanged
  })
})

// ---------------------------------------------------------------------------
// Design-token conflict detection + resolution
// ---------------------------------------------------------------------------

function siteWithTokens(): SiteDocument {
  const base = makeMockSiteDocument()
  const now = Date.now()
  return {
    ...base,
    settings: {
      ...base.settings,
      framework: {
        ...(base.settings.framework ?? {}),
        colors: {
          tokens: [
            {
              id: 'existing-color-id',
              category: '',
              slug: 'bg',
              lightValue: '#000000',
              darkValue: '',
              darkModeEnabled: false,
              generateUtilities: { text: false, background: false, border: false, fill: false },
              generateTransparent: false,
              generateShades: { enabled: false, count: 0 },
              generateTints: { enabled: false, count: 0 },
              order: 0,
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      },
      fonts: {
        ...(base.settings.fonts ?? {}),
        items: base.settings.fonts?.items ?? [],
        tokens: [
          {
            id: 'existing-font-id',
            name: 'Primary',
            variable: 'font-primary',
            fallback: 'sans-serif',
            order: 0,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    },
  }
}

function makeColorToken(slug: string, value = '#ffffff'): ImportColorToken {
  return { slug, value }
}

function makeFontToken(variable: string, family = 'Inter'): ImportFontToken {
  return { name: variable, variable, family, fallback: 'sans-serif' }
}

function makeTokenPlan(
  overrides: Partial<Pick<ImportPlan, 'colors' | 'fontTokens' | 'styleRules' | 'pages'>>,
): ImportPlan {
  return {
    pages: overrides.pages ?? [],
    styleRules: overrides.styleRules ?? [],
    styleRuleSources: (overrides.styleRules ?? []).map(() => 'styles.css'),
    assets: [],
    fonts: [],
    googleFonts: [],
    conditions: [],
    conflicts: { pages: [], rules: [], tokens: [] },
    warnings: [],
    colors: overrides.colors ?? [],
    fontTokens: overrides.fontTokens ?? [],
    scripts: [],
    droppedAtRules: [],
    unusedCss: [],
  }
}

describe('detectConflicts — design tokens', () => {
  it('detects a colour-token slug collision with an existing framework token', () => {
    const { tokens } = detectConflicts(siteWithTokens(), [], [], [makeColorToken('bg')], [])
    expect(tokens).toHaveLength(1)
    expect(tokens[0].kind).toBe('color')
    expect(tokens[0].desiredVariable).toBe('bg')
    expect(tokens[0].existingTokenId).toBe('existing-color-id')
    expect(tokens[0].defaultResolution.action).toBe('auto-rename')
    expect(tokens[0].defaultResolution.resolvedVariable).toBe('bg-2')
  })

  it('detects a font-token variable collision with an existing font token', () => {
    const { tokens } = detectConflicts(siteWithTokens(), [], [], [], [makeFontToken('font-primary')])
    expect(tokens).toHaveLength(1)
    expect(tokens[0].kind).toBe('font')
    expect(tokens[0].desiredVariable).toBe('font-primary')
    expect(tokens[0].existingTokenId).toBe('existing-font-id')
    expect(tokens[0].defaultResolution.resolvedVariable).toBe('font-primary-2')
  })

  it('reports no token conflict when names are unique', () => {
    const { tokens } = detectConflicts(
      siteWithTokens(),
      [],
      [],
      [makeColorToken('brand')],
      [makeFontToken('font-display')],
    )
    expect(tokens).toHaveLength(0)
  })

  it('normalises slug casing/format when comparing (Bg matches bg)', () => {
    const { tokens } = detectConflicts(siteWithTokens(), [], [], [makeColorToken('Bg')], [])
    expect(tokens).toHaveLength(1)
    expect(tokens[0].kind).toBe('color')
  })
})

describe('detectConflicts — rename targets avoid the import\'s own names', () => {
  it('does not auto-rename onto another imported token\'s slug', () => {
    const { tokens } = detectConflicts(siteWithTokens(), [], [], [makeColorToken('bg'), makeColorToken('bg-2')], [])
    expect(tokens).toHaveLength(1)
    expect(tokens[0].defaultResolution.resolvedVariable).toBe('bg-3')
  })

  it('does not auto-rename onto a custom property the imported CSS declares', () => {
    const rule: NewStyleRule = {
      name: 'x', kind: 'class', selector: '.x', order: 0,
      styles: { '--bg-2': '4px', '--font-primary-2': 'serif' }, contextStyles: {},
    }
    const { tokens } = detectConflicts(
      siteWithTokens(), [], [rule], [makeColorToken('bg')], [makeFontToken('font-primary')],
    )
    expect(tokens.map((t) => t.defaultResolution.resolvedVariable)).toEqual(['bg-3', 'font-primary-3'])
  })

  it('detects an authored font variable against an existing token by its emitted name (#619)', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><p class="u">x</p></body></html>`
    const css = `:root { --font-Primary: "Acme Grotesk", serif; } .u { font-family: var(--font-Primary); }`
    const plan = buildImportPlan({ fileMap: makeSinglePageFileMap(html, css), currentSite: siteWithTokens() })

    expect(plan.conflicts.tokens.map((t) => [t.kind, t.desiredVariable, t.defaultResolution.resolvedVariable]))
      .toEqual([['font', 'font-primary', 'font-primary-2']])
    const result = applyConflictResolutions(plan, [], [], plan.conflicts.tokens)
    expect(result.fontTokens.map((t) => t.variable)).toEqual(['font-primary-2'])
    expect(result.styleRules.find((r) => r.selector === '.u')?.styles.fontFamily).toBe('var(--font-primary-2)')
  })

  it('keeps both colours when a normalised name and a conflict rename meet (#615)', () => {
    // `--BG` normalises to `bg-2`, so the conflict rename of `--bg` must not
    // take `bg-2` too, or one colour is lost at commit.
    const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><p class="u">x</p></body></html>`
    const css = `:root { --bg: #111; --BG: #222; } .u { color: var(--BG); background: var(--bg); }`
    const plan = buildImportPlan({ fileMap: makeSinglePageFileMap(html, css), currentSite: siteWithTokens() })
    const result = applyConflictResolutions(plan, [], [], plan.conflicts.tokens)

    expect(result.colors).toEqual([
      { slug: 'bg-3', value: '#111' },
      { slug: 'bg-2', value: '#222' },
    ])
    const u = result.styleRules.find((r) => r.selector === '.u')
    expect(u?.styles).toMatchObject({ color: 'var(--bg-2)', background: 'var(--bg-3)' })
  })
})

describe('applyConflictResolutions — design tokens', () => {
  it('rename: renames the imported colour token AND rewrites var(--bg) refs in style rules', () => {
    const rule: NewStyleRule = {
      name: 'hero',
      kind: 'class',
      selector: '.hero',
      order: 0,
      styles: { backgroundColor: 'var(--bg)', color: 'var(--ink)' },
      contextStyles: {},
    }
    const plan = makeTokenPlan({ colors: [makeColorToken('bg')], styleRules: [rule] })
    const res: TokenConflict = {
      kind: 'color',
      desiredVariable: 'bg',
      existingTokenId: 'existing-color-id',
      defaultResolution: { action: 'auto-rename', resolvedVariable: 'bg-2' },
    }
    const result = applyConflictResolutions(plan, [], [], [res])

    expect(result.colors[0].slug).toBe('bg-2')
    expect(result.styleRules[0].styles.backgroundColor).toBe('var(--bg-2)')
    // An unrelated var reference is left untouched.
    expect(result.styleRules[0].styles.color).toBe('var(--ink)')
  })

  it('custom rename: renames a colour token to its emitted slug and rewrites refs to it', () => {
    const rule: NewStyleRule = {
      name: 'hero',
      kind: 'class',
      selector: '.hero',
      order: 0,
      styles: { color: 'var(--bg)' },
      contextStyles: {},
    }
    const plan = makeTokenPlan({ colors: [makeColorToken('bg')], styleRules: [rule] })
    const res: TokenConflict = {
      kind: 'color',
      desiredVariable: 'bg',
      existingTokenId: 'existing-color-id',
      defaultResolution: { action: 'custom-rename', resolvedVariable: 'Hero BG' },
    }
    const result = applyConflictResolutions(plan, [], [], [res])

    expect(result.colors[0].slug).toBe('hero-bg')
    expect(result.styleRules[0].styles.color).toBe('var(--hero-bg)')
  })

  it('rename: renames a declaration of the token in a non-root rule, with its priority', () => {
    const rule: NewStyleRule = {
      name: 'dark',
      kind: 'class',
      selector: '.dark',
      order: 0,
      styles: { '--bg': '#000', '--other': '#111' },
      stylePriorities: { '--bg': 'important' },
      contextStyles: { 'bp-mobile': { '--bg': '#222' } },
      contextStylePriorities: { 'bp-mobile': { '--bg': 'important' } },
    }
    const plan = makeTokenPlan({ colors: [makeColorToken('bg')], styleRules: [rule] })
    const res: TokenConflict = {
      kind: 'color',
      desiredVariable: 'bg',
      existingTokenId: 'existing-color-id',
      defaultResolution: { action: 'auto-rename', resolvedVariable: 'bg-2' },
    }
    const [result] = applyConflictResolutions(plan, [], [], [res]).styleRules

    expect(result.styles).toEqual({ '--bg-2': '#000', '--other': '#111' })
    expect(result.stylePriorities).toEqual({ '--bg-2': 'important' })
    expect(result.contextStyles).toEqual({ 'bp-mobile': { '--bg-2': '#222' } })
    expect(result.contextStylePriorities).toEqual({ 'bp-mobile': { '--bg-2': 'important' } })
  })

  it('rename: renames a font token\'s declaration in another rule', () => {
    const rule: NewStyleRule = {
      name: 'serif', kind: 'class', selector: '.serif', order: 0,
      styles: { '--font-primary': 'Georgia, serif', fontFamily: 'var(--font-primary)' }, contextStyles: {},
    }
    const plan = makeTokenPlan({ fontTokens: [makeFontToken('font-primary')], styleRules: [rule] })
    const res: TokenConflict = {
      kind: 'font',
      desiredVariable: 'font-primary',
      existingTokenId: 'existing-font-id',
      defaultResolution: { action: 'auto-rename', resolvedVariable: 'font-primary-2' },
    }
    const [result] = applyConflictResolutions(plan, [], [], [res]).styleRules
    expect(result.styles).toEqual({ '--font-primary-2': 'Georgia, serif', fontFamily: 'var(--font-primary-2)' })
  })

  it('rename: renames declarations and references inside raw @keyframes CSS', () => {
    const rule: NewStyleRule = {
      name: 'pulse', kind: 'ambient', selector: '@keyframes pulse', order: 0, styles: {}, contextStyles: {},
      rawCss: '@keyframes pulse {\nfrom { --bg: #000; color: var(--bg); --bgx: #111; }\n}',
    }
    const plan = makeTokenPlan({ colors: [makeColorToken('bg')], styleRules: [rule] })
    const res: TokenConflict = {
      kind: 'color',
      desiredVariable: 'bg',
      existingTokenId: 'existing-color-id',
      defaultResolution: { action: 'auto-rename', resolvedVariable: 'bg-2' },
    }
    const [result] = applyConflictResolutions(plan, [], [], [res]).styleRules
    expect(result.rawCss).toBe('@keyframes pulse {\nfrom { --bg-2: #000; color: var(--bg-2); --bgx: #111; }\n}')
  })

  it('rename: rewrites var refs inside node inlineStyles, preserving fallbacks', () => {
    const page: PagePlan = {
      source: 'index.html',
      title: 'Index',
      slug: 'index',
      linkedCssPaths: [],
      scripts: [],
      nodeFragment: {
        rootIds: ['n'],
        nodes: {
          n: {
            id: 'n',
            moduleId: 'base.text',
            props: { text: 'hi', tag: 'p' },
            breakpointOverrides: {},
            children: [],
            classIds: [],
            inlineStyles: { fontFamily: 'var(--font-primary, serif)' },
          },
        },
      },
    }
    const plan = makeTokenPlan({ fontTokens: [makeFontToken('font-primary')], pages: [page] })
    const res: TokenConflict = {
      kind: 'font',
      desiredVariable: 'font-primary',
      existingTokenId: 'existing-font-id',
      defaultResolution: { action: 'auto-rename', resolvedVariable: 'font-primary-2' },
    }
    const result = applyConflictResolutions(plan, [], [], [res])

    expect(result.fontTokens[0].variable).toBe('font-primary-2')
    expect(result.pages[0].nodeFragment.nodes.n.inlineStyles?.fontFamily).toBe(
      'var(--font-primary-2, serif)',
    )
  })

  it('skip: drops the imported token and keeps references on the original name', () => {
    const rule: NewStyleRule = {
      name: 'hero',
      kind: 'class',
      selector: '.hero',
      order: 0,
      styles: { backgroundColor: 'var(--bg)' },
      contextStyles: {},
    }
    const plan = makeTokenPlan({ colors: [makeColorToken('bg')], styleRules: [rule] })
    const res: TokenConflict = {
      kind: 'color',
      desiredVariable: 'bg',
      existingTokenId: 'existing-color-id',
      defaultResolution: { action: 'skip' },
    }
    const result = applyConflictResolutions(plan, [], [], [res])

    // Imported token dropped — existing token wins.
    expect(result.colors).toHaveLength(0)
    // Reference unchanged → binds to the existing token at publish.
    expect(result.styleRules[0].styles.backgroundColor).toBe('var(--bg)')
  })

  it('overwrite: keeps the imported token and leaves references on the original name', () => {
    const plan = makeTokenPlan({ colors: [makeColorToken('bg', '#123456')] })
    const res: TokenConflict = {
      kind: 'color',
      desiredVariable: 'bg',
      existingTokenId: 'existing-color-id',
      defaultResolution: { action: 'overwrite' },
    }
    const result = applyConflictResolutions(plan, [], [], [res])

    // Token stays in the plan with its original slug + value (commit overwrites by id).
    expect(result.colors).toHaveLength(1)
    expect(result.colors[0].slug).toBe('bg')
    expect(result.colors[0].value).toBe('#123456')
  })
})
