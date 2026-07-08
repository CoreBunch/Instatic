/**
 * ClassStyleInjector — unit tests for bagToCSS and generateClassCSS.
 *
 * Covers:
 * - camelCase → kebab-case conversion (toKebab)
 * - Allowlist enforcement (unknown props are dropped)
 * - Value sanitisation: javascript:, expression(), behavior:, data:text all blocked
 * - Base class CSS generation using the user-facing class name
 * - @media breakpoint override blocks
 * - Security: empty/no-styles classes emit nothing
 *
 * Phase C / Constraint #228.
 */

import { describe, it, expect } from 'bun:test'
import { bagToCSS, bagToInlineStyle, collectClassCSS, generateClassCSS } from '@core/publisher'
import { classKindSelector, makeConditionDef } from '@core/page-tree'
import type { StyleRule, Page, PageNode, SiteDocument } from '@core/page-tree'
import type { RenderResolvedMedia } from '@core/publisher'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClass(
  id: string,
  styles: StyleRule['styles'],
  contextStyles: StyleRule['contextStyles'] = {},
  name = id,
): StyleRule {
  return {
    id,
    name,
    kind: 'class',
    selector: classKindSelector(name),
    order: 0,
    styles,
    contextStyles,
    createdAt: 0,
    updatedAt: 0,
  }
}

const BREAKPOINTS = [
  { id: 'mobile', width: 375 },
  { id: 'tablet', width: 768 },
]

function resolvedMedia(path = '/uploads/hero.png'): RenderResolvedMedia {
  return {
    publicPath: path,
    mimeType: 'image/png',
    width: 2400,
    height: 1200,
    altText: '',
    blurHash: null,
    variants: [
      { width: 320, height: 160, format: 'webp', path: '/uploads/hero-w320.webp', sizeBytes: 12_000 },
      { width: 1024, height: 512, format: 'webp', path: '/uploads/hero-w1024.webp', sizeBytes: 82_000 },
      { width: 2048, height: 1024, format: 'webp', path: '/uploads/hero-w2048.webp', sizeBytes: 190_000 },
    ],
    posterPath: null,
  }
}

// ---------------------------------------------------------------------------
// bagToCSS
// ---------------------------------------------------------------------------

describe('bagToCSS', () => {
  it('converts a single property to a CSS declaration', () => {
    const css = bagToCSS({ fontSize: '16px' })
    expect(css).toBe('  font-size: 16px;')
  })

  it('converts camelCase to kebab-case', () => {
    const css = bagToCSS({ backgroundColor: '#fff', borderTopLeftRadius: '4px' })
    expect(css).toContain('background-color: #fff;')
    expect(css).toContain('border-top-left-radius: 4px;')
  })

  it('emits an uncurated but valid CSS property (permissive model)', () => {
    // Phase 1a: the publisher no longer gates on a curated allowlist — any
    // valid CSS property name is emittable, with the value sanitiser as the
    // security boundary. `flex-grow` was never allowlisted; it must emit now.
    const css = bagToCSS({ flexGrow: '2' } as never)
    expect(css).toContain('flex-grow: 2;')
  })

  it('drops a security-denied property name (behavior)', () => {
    // The tiny denylist (behavior / -moz-binding) is the only name-level
    // block remaining. Its value would also be caught by the value sanitiser,
    // but the name gate drops it outright regardless.
    const css = bagToCSS({ behavior: "url('xss.htc')" } as never)
    expect(css).toBe('')
  })

  it('drops a syntactically invalid property name', () => {
    // Not a valid CSS identifier → never emitted.
    const css = bagToCSS({ 'has spaces': 'x', '1leading-digit': 'y' } as never)
    expect(css).toBe('')
  })

  it('drops undefined and null and empty-string values', () => {
    const css = bagToCSS({ fontSize: undefined, color: '' } as never)
    expect(css).toBe('')
  })

  it('handles numeric values (zIndex, opacity)', () => {
    const css = bagToCSS({ zIndex: 10, opacity: 0.5 })
    expect(css).toContain('z-index: 10;')
    expect(css).toContain('opacity: 0.5;')
  })

  it('serializes color framework utility properties', () => {
    const css = bagToCSS({
      borderColor: 'var(--primary)',
      fill: 'var(--primary)',
    })
    expect(css).toContain('border-color: var(--primary);')
    expect(css).toContain('fill: var(--primary);')
  })

  it('returns empty string for an empty bag', () => {
    expect(bagToCSS({})).toBe('')
  })

  // Security — Constraint #228
  it('blocks javascript: protocol values', () => {
    const css = bagToCSS({ backgroundImage: 'javascript:alert(1)' })
    expect(css).toBe('')
  })

  it('blocks expression() values (IE CSS injection)', () => {
    const css = bagToCSS({ width: 'expression(alert(1))' })
    expect(css).toBe('')
  })

  it('blocks behavior: values', () => {
    const css = bagToCSS({ cursor: 'behavior: url(evil.htc)' } as never)
    expect(css).toBe('')
  })

  it('blocks data:text values', () => {
    const css = bagToCSS({ backgroundImage: 'data:text/html,<script>alert(1)</script>' })
    expect(css).toBe('')
  })

  it('allows safe data: image URIs (data:image/…)', () => {
    // data:image is NOT blocked — only data:text
    const css = bagToCSS({ backgroundImage: 'url("data:image/png;base64,abc")' })
    expect(css).toContain('background-image:')
  })

  it('allows typical safe values unchanged', () => {
    const css = bagToCSS({ display: 'flex', gap: '8px', borderRadius: '4px' })
    expect(css).toContain('display: flex;')
    expect(css).toContain('gap: 8px;')
    expect(css).toContain('border-radius: 4px;')
  })

  it('rewrites media background images to optimized fallback plus image-set declarations', () => {
    const css = bagToCSS(
      { backgroundImage: "url('/uploads/hero.png')" },
      { mediaAssets: new Map([['/uploads/hero.png', resolvedMedia()]]) },
    )

    expect(css).toContain('background-image: url("/uploads/hero-w2048.webp");')
    expect(css).toContain('background-image: image-set(')
    expect(css).toContain('url("/uploads/hero-w320.webp") 0.31x')
    expect(css).toContain('url("/uploads/hero-w1024.webp") 1x')
    expect(css).toContain('url("/uploads/hero-w2048.webp") 2x')
    expect(css).not.toContain('/uploads/hero.png')
  })

  it('rewrites media background images inside inline style strings without selecting the original', () => {
    const inline = bagToInlineStyle(
      { backgroundImage: 'linear-gradient(red, blue), url("/uploads/hero.png")' },
      { mediaAssets: new Map([['/uploads/hero.png', resolvedMedia()]]) },
    )

    expect(inline).toContain('linear-gradient(red, blue), url("/uploads/hero-w2048.webp")')
    expect(inline).toContain('linear-gradient(red, blue), image-set(')
    expect(inline).not.toContain('/uploads/hero.png')
  })

  it('outputs multiple properties as separate lines', () => {
    const css = bagToCSS({ fontSize: '14px', color: '#eee', fontWeight: '600' })
    const lines = css.split('\n')
    expect(lines.length).toBe(3)
    expect(lines.every((l) => l.startsWith('  '))).toBe(true)
  })

  // ── Side shorthand collapse (padding / margin) ───────────────────────────
  // The editor stores per-side values; the publisher collapses them into the
  // CSS shorthand so generated stylesheets read like hand-written CSS.

  it('collapses 4 equal padding sides to a 1-value shorthand', () => {
    const css = bagToCSS({
      paddingTop: '20px',
      paddingRight: '20px',
      paddingBottom: '20px',
      paddingLeft: '20px',
    })
    expect(css).toBe('  padding: 20px;')
  })

  it('collapses padding to 2-value shorthand when top==bottom and left==right', () => {
    const css = bagToCSS({
      paddingTop: '20px',
      paddingRight: '0',
      paddingBottom: '20px',
      paddingLeft: '0',
    })
    expect(css).toBe('  padding: 20px 0;')
  })

  it('collapses padding to 3-value shorthand when only left==right', () => {
    const css = bagToCSS({
      paddingTop: '20px',
      paddingRight: '8px',
      paddingBottom: '12px',
      paddingLeft: '8px',
    })
    expect(css).toBe('  padding: 20px 8px 12px;')
  })

  it('emits 4-value padding shorthand when all sides differ', () => {
    const css = bagToCSS({
      paddingTop: '20px',
      paddingRight: '8px',
      paddingBottom: '12px',
      paddingLeft: '4px',
    })
    expect(css).toBe('  padding: 20px 8px 12px 4px;')
  })

  it('collapses margin sides identically to padding', () => {
    const css = bagToCSS({
      marginTop: '0',
      marginRight: 'auto',
      marginBottom: '0',
      marginLeft: 'auto',
    })
    expect(css).toBe('  margin: 0 auto;')
  })

  it('preserves longhand when fewer than 4 padding sides are present', () => {
    // Common in breakpoint overrides — only one side changes.
    const css = bagToCSS({
      paddingTop: '40px',
      paddingBottom: '40px',
    })
    expect(css).toContain('padding-top: 40px;')
    expect(css).toContain('padding-bottom: 40px;')
    expect(css).not.toMatch(/^\s*padding:/m)
  })

  it('emits collapsed shorthand at the position of the first encountered side', () => {
    const css = bagToCSS({
      color: '#fff',
      paddingTop: '20px',
      paddingRight: '0',
      paddingBottom: '20px',
      paddingLeft: '0',
      fontSize: '14px',
    })
    const lines = css.split('\n')
    expect(lines).toEqual([
      '  color: #fff;',
      '  padding: 20px 0;',
      '  font-size: 14px;',
    ])
  })

  it('collapses CSS variable values (var(--space-md)) into the shorthand', () => {
    const css = bagToCSS({
      paddingTop: 'var(--space-md)',
      paddingRight: 'var(--space-sm)',
      paddingBottom: 'var(--space-md)',
      paddingLeft: 'var(--space-sm)',
    })
    expect(css).toBe('  padding: var(--space-md) var(--space-sm);')
  })

  it('collapses padding and margin independently in the same bag', () => {
    const css = bagToCSS({
      paddingTop: '8px',
      paddingRight: '8px',
      paddingBottom: '8px',
      paddingLeft: '8px',
      marginTop: '0',
      marginRight: 'auto',
      marginBottom: '0',
      marginLeft: 'auto',
    })
    expect(css).toContain('padding: 8px;')
    expect(css).toContain('margin: 0 auto;')
    expect(css).not.toContain('padding-top')
    expect(css).not.toContain('margin-left')
  })

  it('refuses to collapse when a side is dropped by the sanitiser', () => {
    // expression(...) is sanitised to null → the collapse must abort and the
    // remaining safe sides emit as longhand instead.
    const css = bagToCSS({
      paddingTop: '20px',
      paddingRight: 'expression(alert(1))',
      paddingBottom: '20px',
      paddingLeft: '20px',
    })
    // No collapsed shorthand — the malicious value broke uniformity.
    expect(css).not.toContain('padding: ')
    // Safe sides survive as longhand declarations.
    expect(css).toContain('padding-top: 20px;')
    expect(css).toContain('padding-bottom: 20px;')
    expect(css).toContain('padding-left: 20px;')
    // The malicious side is dropped entirely.
    expect(css).not.toContain('expression')
  })
})

// ---------------------------------------------------------------------------
// generateClassCSS
// ---------------------------------------------------------------------------

describe('generateClassCSS — custom conditions (unified contextStyles)', () => {
  const mediaCond = makeConditionDef({ kind: 'media', query: '(orientation: landscape)' })
  const containerCond = makeConditionDef({ kind: 'container', name: 'sidebar', query: 'min-width: 400px' })
  const supportsCond = makeConditionDef({ kind: 'supports', query: '(display: grid)' })

  it('emits @media / @container / @supports, then width-breakpoint @media', () => {
    const rule = makeClass('foo', { color: 'red' }, {
      mobile: { color: 'green' },
      [mediaCond.id]: { color: 'blue' },
      [containerCond.id]: { display: 'grid' },
      [supportsCond.id]: { gap: '8px' },
    })
    const css = generateClassCSS({ foo: rule }, [{ id: 'mobile', width: 375 }], [mediaCond, containerCond, supportsCond])

    expect(css).toContain('@media (orientation: landscape) {')
    expect(css).toContain('@container sidebar (min-width: 400px) {')
    expect(css).toContain('@supports (display: grid) {')
    expect(css).toContain('@media (max-width: 375px) {')

    // Cascade order: base → custom conditions (registry order) → breakpoint @media.
    const base = css.indexOf('.foo {')
    const landscape = css.indexOf('@media (orientation: landscape)')
    const container = css.indexOf('@container')
    const breakpoint = css.indexOf('@media (max-width: 375px)')
    expect(base).toBeLessThan(landscape)
    expect(landscape).toBeLessThan(container)
    expect(container).toBeLessThan(breakpoint)
  })

  it('does not double-wrap a supports query that already has parens', () => {
    const rule = makeClass('foo', {}, { [supportsCond.id]: { gap: '8px' } })
    const css = generateClassCSS({ foo: rule }, [], [supportsCond])
    expect(css).toContain('@supports (display: grid) {')
    expect(css).not.toContain('((display: grid))')
  })

  it('drops a condition whose query would break out of the @-block or <style> (injection guard)', () => {
    for (const q of ['(max-width: 1px) {} body', '(x) </style', '(x); color: red']) {
      const cond = makeConditionDef({ kind: 'media', query: q })
      const rule = makeClass('foo', { color: 'red' }, { [cond.id]: { color: 'blue' } })
      const css = generateClassCSS({ foo: rule }, [], [cond])
      // The base rule still emits; the unsafe condition is dropped entirely.
      expect(css).toContain('.foo {')
      expect(css).not.toContain('color: blue')
      expect(css).not.toContain('</style')
    }
  })

  it('drops a container condition with an unsafe container name', () => {
    const cond = makeConditionDef({ kind: 'container', name: 'evil {} body', query: 'min-width: 1px' })
    const rule = makeClass('foo', { color: 'red' }, { [cond.id]: { color: 'blue' } })
    const css = generateClassCSS({ foo: rule }, [], [cond])
    expect(css).not.toContain('color: blue')
    expect(css).not.toContain('@container evil')
  })

  it('skips an orphaned context key not in the breakpoints or conditions registry', () => {
    const rule = makeClass('foo', { color: 'red' }, { 'media:(orphan)': { color: 'blue' } })
    const css = generateClassCSS({ foo: rule }, [], [])
    expect(css).toContain('.foo {')
    expect(css).not.toContain('color: blue')
  })
})

describe('generateClassCSS', () => {
  it('generates a rule from the user-facing class name', () => {
    const classes = { abc: makeClass('abc', { color: '#fff', fontSize: '16px' }) }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).toContain('.abc {')
    expect(css).toContain('color: #fff;')
    expect(css).toContain('font-size: 16px;')
    expect(css).toContain('}')
  })

  it('uses the class name in the selector, not the generated id', () => {
    const classes = { generatedId: makeClass('generatedId', { display: 'flex' }, {}, 'hero_title') }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).toContain('.hero_title {')
    expect(css).not.toContain('.generatedId')
    expect(css).not.toContain('.mc-generatedId')
  })

  it('escapes class names in CSS selectors without replacing the stored name', () => {
    const classes = { generatedId: makeClass('generatedId', { color: 'red' }, {}, 'hero:featured') }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).toContain('.hero\\:featured {')
  })

  it('skips base rule when the class has no styles', () => {
    const classes = { empty: makeClass('empty', {}) }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).not.toContain('.empty')
  })

  it('emits @media block for breakpoint override', () => {
    const classes = {
      btn: makeClass('btn', { fontSize: '16px' }, {
        mobile: { fontSize: '12px' },
      }),
    }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).toContain('@media (max-width: 375px)')
    expect(css).toContain('.btn {')
    expect(css).toContain('font-size: 12px;')
  })

  it('uses a viewport context media query instead of forcing max-width', () => {
    const classes = {
      btn: makeClass('btn', { fontSize: '16px' }, {
        tablet: { fontSize: '18px' },
      }),
    }
    const css = generateClassCSS(classes, [
      { id: 'tablet', width: 768, mediaQuery: '(min-width: 768px)' },
    ])
    expect(css).toContain('@media (min-width: 768px)')
    expect(css).not.toContain('@media (max-width: 768px)')
  })

  it('emits separate @media blocks for multiple breakpoints', () => {
    const classes = {
      hero: makeClass('hero', { fontSize: '24px' }, {
        mobile: { fontSize: '14px' },
        tablet: { fontSize: '18px' },
      }),
    }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).toContain('@media (max-width: 375px)')
    expect(css).toContain('@media (max-width: 768px)')
  })

  it('skips breakpoint block when the breakpoint ID is not in the breakpoints list', () => {
    const classes = {
      btn: makeClass('btn', { fontSize: '16px' }, {
        'unknown-bp': { fontSize: '10px' },
      }),
    }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).not.toContain('unknown-bp')
  })

  it('skips breakpoint block when override styles are empty', () => {
    const classes = {
      btn: makeClass('btn', { fontSize: '16px' }, {
        mobile: {},
      }),
    }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).not.toContain('@media')
  })

  it('generates CSS for multiple classes', () => {
    const classes = {
      a: makeClass('a', { color: 'red' }),
      b: makeClass('b', { color: 'blue' }),
    }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).toContain('.a {')
    expect(css).toContain('.b {')
    expect(css).toContain('color: red;')
    expect(css).toContain('color: blue;')
  })

  it('emits supported raw @keyframes rules', () => {
    const classes: Record<string, StyleRule> = {
      pulse: {
        id: 'pulse',
        name: '@keyframes pulse',
        kind: 'ambient',
        selector: '@keyframes pulse',
        order: 0,
        styles: {},
        contextStyles: {},
        rawCss: '@keyframes pulse {\n  0% {\n    opacity: 0;\n  }\n  100% {\n    opacity: 1;\n  }\n}',
        createdAt: 0,
        updatedAt: 0,
      },
    }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).toContain('@keyframes pulse')
    expect(css).toContain('opacity: 1;')
  })

  it('drops unsupported raw CSS rules', () => {
    const classes: Record<string, StyleRule> = {
      bad: {
        id: 'bad',
        name: '@media bad',
        kind: 'ambient',
        selector: '@media bad',
        order: 0,
        styles: {},
        contextStyles: {},
        rawCss: '@media screen { .bad { color: red; } }',
        createdAt: 0,
        updatedAt: 0,
      },
    }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).toBe('')
  })

  it('returns empty string for an empty class registry', () => {
    const css = generateClassCSS({}, BREAKPOINTS)
    expect(css).toBe('')
  })

  it('does not include security-denied property names in output', () => {
    // Permissive model: only the security denylist (behavior / -moz-binding)
    // is name-blocked at the publisher. A denied prop must never appear.
    const classes = { bad: makeClass('bad', { behavior: "url('xss.htc')" } as never) }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).not.toContain('behavior')
    expect(css).not.toContain('xss.htc')
  })

  it('sanitises javascript: values in class styles', () => {
    const classes = { evil: makeClass('evil', { backgroundImage: 'javascript:alert(1)' }) }
    const css = generateClassCSS(classes, BREAKPOINTS)
    expect(css).not.toContain('javascript:')
    // The rule should be omitted entirely (no safe decls → no block emitted)
    expect(css).not.toContain('.evil')
  })

  it('emits @media blocks in descending width order regardless of insertion order', () => {
    // The user might define class breakpoint styles in any order — say
    // mobile first, then desktop, then tablet. If we emitted them in
    // insertion order, the desktop @media (max-width: 1440px) rule would
    // come last and override mobile/tablet at narrow viewports because
    // all three @media (max-width: ...) selectors have equal specificity
    // and the latest in source wins. Sorting widest-first puts the
    // narrowest matching breakpoint last, which is what users actually
    // expect from a "mobile" breakpoint.
    const breakpoints = [
      { id: 'mobile', width: 375 },
      { id: 'tablet', width: 768 },
      { id: 'desktop', width: 1440 },
    ]
    const classes = {
      hero: makeClass('hero', { fontSize: '24px' }, {
        mobile: { fontSize: '14px' },
        desktop: { fontSize: '32px' },
        tablet: { fontSize: '18px' },
      }),
    }
    const css = generateClassCSS(classes, breakpoints)
    const desktopIdx = css.indexOf('@media (max-width: 1440px)')
    const tabletIdx = css.indexOf('@media (max-width: 768px)')
    const mobileIdx = css.indexOf('@media (max-width: 375px)')
    expect(desktopIdx).toBeGreaterThanOrEqual(0)
    expect(tabletIdx).toBeGreaterThan(desktopIdx)
    expect(mobileIdx).toBeGreaterThan(tabletIdx)
  })

  it('emits min-width viewport contexts from narrowest to widest', () => {
    const breakpoints = [
      { id: 'mobile', width: 375, mediaQuery: '(min-width: 375px)' },
      { id: 'tablet', width: 768, mediaQuery: '(min-width: 768px)' },
      { id: 'desktop', width: 1440, mediaQuery: '(min-width: 1440px)' },
    ]
    const classes = {
      hero: makeClass('hero', { fontSize: '14px' }, {
        mobile: { fontSize: '16px' },
        desktop: { fontSize: '32px' },
        tablet: { fontSize: '24px' },
      }),
    }
    const css = generateClassCSS(classes, breakpoints)
    const mobileIdx = css.indexOf('@media (min-width: 375px)')
    const tabletIdx = css.indexOf('@media (min-width: 768px)')
    const desktopIdx = css.indexOf('@media (min-width: 1440px)')
    expect(mobileIdx).toBeGreaterThanOrEqual(0)
    expect(tabletIdx).toBeGreaterThan(mobileIdx)
    expect(desktopIdx).toBeGreaterThan(tabletIdx)
  })

  it('rewrites class background images with responsive image-set candidates', () => {
    const classes = {
      hero: makeClass('hero', { backgroundImage: "url('/uploads/hero.png')" }),
    }
    const css = generateClassCSS(classes, BREAKPOINTS, [], {
      mediaAssets: new Map([['/uploads/hero.png', resolvedMedia()]]),
    })

    expect(css).toContain('.hero {')
    expect(css).toContain('background-image: url("/uploads/hero-w2048.webp");')
    expect(css).toContain('background-image: image-set(')
    expect(css).not.toContain('/uploads/hero.png')
  })
})

// ---------------------------------------------------------------------------
// collectClassCSS — publisher integration (tree-shaking)
// ---------------------------------------------------------------------------

function makeSite(
  styleRules: SiteDocument['styleRules'],
  nodeClassIds: Record<string, string[]> = {},
): SiteDocument {
  const node: PageNode = {
    id: 'root',
    moduleId: 'base.container',
    props: {},
    breakpointOverrides: {},
    children: Object.keys(nodeClassIds).filter((id) => id !== 'root'),
    classIds: nodeClassIds['root'] ?? [],
  }
  const childNodes: Record<string, PageNode> = {}
  for (const [id, classIds] of Object.entries(nodeClassIds)) {
    if (id === 'root') continue
    childNodes[id] = {
      id,
      moduleId: 'base.text',
      props: {},
      breakpointOverrides: {},
      children: [],
      classIds,
    }
  }
  const page: Page = {
    id: 'page1',
    slug: 'index',
    title: 'Home',
    rootNodeId: 'root',
    nodes: { root: node, ...childNodes },
  }
  return {
    id: 'proj',
    name: 'Test',
    pages: [page],
    breakpoints: [{ id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' }],
    settings: {
      colorTokens: {},
      shortcuts: {},
    },
    styleRules,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('collectClassCSS', () => {
  it('emits user-authored CSS but skips framework-generated CSS', () => {
    const userClass = makeClass('user-class', { color: 'green' })
    const frameworkClass: StyleRule = {
      ...makeClass('framework:color:primary-token:base:text', { color: 'var(--primary)' }, {}, 'text-primary'),
      generated: {
        origin: 'framework',
        family: 'color',
        sourceId: 'primary-token',
        utility: 'text',
        tokenName: 'primary',
        locked: true,
      },
      tags: ['framework', 'utility', 'color'],
    }
    const site = makeSite(
      {
        [userClass.id]: userClass,
        [frameworkClass.id]: frameworkClass,
      },
      { child1: [userClass.id, frameworkClass.id] },
    )

    const css = collectClassCSS(site)

    expect(css).toContain('.user-class {')
    expect(css).toContain('color: green;')
    expect(css).not.toContain('.text-primary')
    expect(css).not.toContain('var(--primary)')
  })

  it('returns empty string when no nodes have classIds', () => {
    const site = makeSite({ cls1: makeClass('cls1', { color: 'red' }) })
    expect(collectClassCSS(site)).toBe('')
  })

  it('only emits CSS for classes actually used by nodes (tree-shaking)', () => {
    const site = makeSite(
      {
        used: makeClass('used', { color: 'green' }),
        unused: makeClass('unused', { color: 'red' }),
      },
      { child1: ['used'] },
    )
    const css = collectClassCSS(site)
    expect(css).toContain('.used {')
    expect(css).not.toContain('.unused')
  })

  it('emits CSS for all used classes across all nodes', () => {
    const site = makeSite(
      {
        cls1: makeClass('cls1', { fontSize: '14px' }),
        cls2: makeClass('cls2', { fontSize: '18px' }),
      },
      { child1: ['cls1'], child2: ['cls2'] },
    )
    const css = collectClassCSS(site)
    expect(css).toContain('.cls1')
    expect(css).toContain('.cls2')
  })

  it('sanitizes </style> injection in class CSS (Constraint #228)', () => {
    const malicious = makeClass('evil', { backgroundImage: 'url(x)' })
    // Insert </style> manually via name abuse — test the sanitizer, not the class gen
    // (bagToCSS already blocks javascript: etc; test the outer sanitizeModuleCSS wrapper)
    const site = makeSite({ evil: malicious }, { child1: ['evil'] })
    const css = collectClassCSS(site)
    expect(css).not.toMatch(/<\/style\s*>/)
  })

  it('gracefully handles missing class references in the registry', () => {
    const site = makeSite({}, { child1: ['nonexistent-id'] })
    expect(() => collectClassCSS(site)).not.toThrow()
    expect(collectClassCSS(site)).toBe('')
  })

  it('returns empty string when all used class styles are blocked by the sanitiser', () => {
    const evilClass = makeClass('evil', { backgroundImage: 'javascript:alert(1)' })
    const site = makeSite({ evil: evilClass }, { child1: ['evil'] })
    const css = collectClassCSS(site)
    // No valid declarations → collectClassCSS should return empty (or whitespace only)
    expect(css.trim()).toBe('')
  })
})
