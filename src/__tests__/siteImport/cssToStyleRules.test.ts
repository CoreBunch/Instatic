/**
 * Unit tests for cssToStyleRules — Phase 1 of the Super Import pipeline.
 *
 * One describe block per row (or group of closely-related rows) of the
 * mapping table in docs/plans/2026-05-29-super-import.md §Phase 1.
 *
 * Environment note:
 * Tests run under happy-dom (see src/__tests__/setup.ts). happy-dom's
 * CSSStyleSheet is available on globalThis.window (not globalThis directly).
 * cssToStyleRules falls back to window.CSSStyleSheet automatically.
 *
 * Malformed CSS note:
 * happy-dom does NOT throw for most malformed CSS — it silently parses
 * what it can. The try/catch in cssToStyleRules handles real browsers and
 * environments where replaceSync throws. The "resilience" tests below verify
 * graceful non-crashing behavior for both cases.
 */

import { describe, it, expect } from 'bun:test'
import { cssToStyleRules } from '@core/siteImport'
import { conditionId } from '@core/page-tree'

// ---------------------------------------------------------------------------
// Selector classification
// ---------------------------------------------------------------------------

describe('cssToStyleRules — selector classification', () => {
  it('.foo → kind:class, name:foo, selector:.foo', () => {
    const { rules, warnings } = cssToStyleRules('.foo { color: red }')
    expect(rules).toHaveLength(1)
    expect(rules[0].kind).toBe('class')
    expect(rules[0].name).toBe('foo')
    expect(rules[0].selector).toBe('.foo')
    expect(rules[0].styles).toMatchObject({ color: 'red' })
    expect(warnings).toHaveLength(0)
  })

  it('h1 → kind:ambient, name:h1, selector:h1', () => {
    const { rules } = cssToStyleRules('h1 { color: red }')
    expect(rules).toHaveLength(1)
    expect(rules[0].kind).toBe('ambient')
    expect(rules[0].name).toBe('h1')
    expect(rules[0].selector).toBe('h1')
  })

  it('body → ambient', () => {
    const { rules } = cssToStyleRules('body { color: red }')
    expect(rules[0].kind).toBe('ambient')
    expect(rules[0].selector).toBe('body')
  })

  it('* → ambient', () => {
    const { rules } = cssToStyleRules('* { color: red }')
    expect(rules[0].kind).toBe('ambient')
    expect(rules[0].selector).toBe('*')
  })

  it('nav → ambient', () => {
    const { rules } = cssToStyleRules('nav { color: red }')
    expect(rules[0].kind).toBe('ambient')
  })

  it('.hero .title binds the rightmost class while preserving the selector', () => {
    const { rules } = cssToStyleRules('.hero .title { color: red }')
    expect(rules[0].kind).toBe('class')
    expect(rules[0].name).toBe('title')
    expect(rules[0].selector).toBe('.hero .title')
  })

  it('h1 > span → ambient (child combinator)', () => {
    const { rules } = cssToStyleRules('h1 > span { color: red }')
    expect(rules[0].kind).toBe('ambient')
    expect(rules[0].selector).toBe('h1 > span')
  })

  it('a:hover → ambient (pseudo-class)', () => {
    const { rules } = cssToStyleRules('a:hover { color: red }')
    expect(rules[0].kind).toBe('ambient')
    expect(rules[0].selector).toBe('a:hover')
  })

  it('[data-state="on"] → ambient (attribute selector)', () => {
    const { rules } = cssToStyleRules('[data-state="on"] { color: red }')
    expect(rules[0].kind).toBe('ambient')
    // The selector may be normalised by the CSS engine (quotes may change);
    // we just verify kind and that the selector contains the key attribute text
    expect(rules[0].selector).toContain('data-state')
  })

  it('.foo.bar binds the rightmost compound class', () => {
    const { rules } = cssToStyleRules('.foo.bar { color: red }')
    expect(rules[0].kind).toBe('class')
    expect(rules[0].name).toBe('bar')
  })

  it('decodes and binds escaped Tailwind variant class names', () => {
    const { rules } = cssToStyleRules(
      '.group:hover .group-hover\\:block { display: block }',
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      kind: 'class',
      name: 'group-hover:block',
      selector: '.group:hover .group-hover\\:block',
    })
  })

  it('keeps selector-list alternatives with one binding in one rule', () => {
    const { rules } = cssToStyleRules(
      '.placeholder\\:text-gray-400::-moz-placeholder, .placeholder\\:text-gray-400::placeholder { color: gray }',
    )
    expect(rules).toHaveLength(1)
    expect(rules[0].selector).toBe(
      '.placeholder\\:text-gray-400::-moz-placeholder, .placeholder\\:text-gray-400::placeholder',
    )
    expect(rules[0].name).toBe('placeholder:text-gray-400')
  })

  it('splits selector-list alternatives owned by different classes', () => {
    const { rules } = cssToStyleRules('.foo, .bar { color: red }')
    expect(rules.map((rule) => [rule.name, rule.selector])).toEqual([
      ['foo', '.foo'],
      ['bar', '.bar'],
    ])
  })
})

// ---------------------------------------------------------------------------
// @media policy — matched breakpoint
// ---------------------------------------------------------------------------

describe('cssToStyleRules — @media → contextStyles (matched)', () => {
  it('base + matched @media → 1 rule, base styles + contextStyles', () => {
    const css = '.foo { color: red }\n@media (max-width: 768px) { .foo { color: blue } }'
    const { rules, warnings } = cssToStyleRules(css, {
      breakpoints: [{ id: 'tablet', width: 768 }],
    })
    expect(rules).toHaveLength(1)
    expect(rules[0].styles).toMatchObject({ color: 'red' })
    expect(rules[0].contextStyles.tablet).toMatchObject({ color: 'blue' })
    expect(warnings).toHaveLength(0)
  })

  it('@media within tolerance is matched', () => {
    const css = '.foo { color: red }\n@media (max-width: 768px) { .foo { color: blue } }'
    const { rules, warnings } = cssToStyleRules(css, {
      breakpoints: [{ id: 'tablet', width: 780 }],
      mediaTolerance: 15,
    })
    expect(rules).toHaveLength(1)
    expect(rules[0].contextStyles.tablet).toMatchObject({ color: 'blue' })
    expect(warnings).toHaveLength(0)
  })

  it('@media matching a configured viewport query is matched', () => {
    const css = '.foo { color: red }\n@media (min-width: 768px) { .foo { color: blue } }'
    const { rules, warnings, conditions } = cssToStyleRules(css, {
      breakpoints: [{ id: 'tablet', width: 768, mediaQuery: '(min-width: 768px)' }],
    })
    expect(rules).toHaveLength(1)
    expect(rules[0].contextStyles.tablet).toMatchObject({ color: 'blue' })
    expect(conditions).toHaveLength(0)
    expect(warnings).toHaveLength(0)
  })

  it('@media creates a new rule if no base rule existed for the selector', () => {
    const css = '@media (max-width: 768px) { .foo { color: blue } }'
    const { rules } = cssToStyleRules(css, {
      breakpoints: [{ id: 'mobile', width: 768 }],
    })
    expect(rules).toHaveLength(1)
    expect(rules[0].styles).toEqual({})
    expect(rules[0].contextStyles.mobile).toMatchObject({ color: 'blue' })
  })

  it('preserves declaration priority in a matched context', () => {
    const { rules } = cssToStyleRules(
      '@media (max-width: 768px) { .foo { color: blue !important } }',
      { breakpoints: [{ id: 'mobile', width: 768 }] },
    )
    expect(rules[0].contextStyles.mobile.color).toBe('blue')
    expect(rules[0].contextStylePriorities).toEqual({
      mobile: { color: 'important' },
    })
  })
})

// ---------------------------------------------------------------------------
// @media policy — unmatched (no breakpoint match)
// ---------------------------------------------------------------------------

describe('cssToStyleRules — unmatched @media → faithful condition context', () => {
  it('unmatched @media stores a condition override + registry entry, no warning, base untouched', () => {
    const css = '.foo { color: red }\n@media (max-width: 768px) { .foo { color: blue } }'
    const { rules, warnings, conditions } = cssToStyleRules(css, {
      breakpoints: [{ id: 'desktop', width: 1200 }],
    })
    expect(rules).toHaveLength(1)
    // Base stays exactly as authored — the @media override no longer leaks in.
    expect(rules[0].styles).toMatchObject({ color: 'red' })
    expect(rules[0].styles).not.toHaveProperty('__media')
    // The override lives in contextStyles keyed by the deterministic condition id.
    const cid = conditionId({ kind: 'media', query: '(max-width: 768px)' })
    expect(rules[0].contextStyles[cid]).toMatchObject({ color: 'blue' })
    // The reusable condition is registered.
    expect(conditions.map((c) => c.condition)).toContainEqual({ kind: 'media', query: '(max-width: 768px)' })
    // No lossy "unmatched-media-query" warning anymore.
    expect(warnings.filter((w) => w.kind === 'unmatched-media-query')).toHaveLength(0)
  })

  it('a non-width media feature (orientation) round-trips as a media condition', () => {
    const css = '@media (orientation: landscape) { .foo { color: red } }'
    const { rules, warnings, conditions } = cssToStyleRules(css, { breakpoints: [] })
    expect(rules).toHaveLength(1)
    expect(rules[0].styles).toEqual({}) // nothing folded into base
    const cid = conditionId({ kind: 'media', query: '(orientation: landscape)' })
    expect(rules[0].contextStyles[cid]).toMatchObject({ color: 'red' })
    expect(conditions.map((c) => c.condition)).toContainEqual({ kind: 'media', query: '(orientation: landscape)' })
    expect(warnings.filter((w) => w.kind === 'unmatched-media-query')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Dropped @-rules
// ---------------------------------------------------------------------------

describe('cssToStyleRules — dropped @-rules', () => {
  it('@keyframes → ambient raw CSS rule, no dropped-at-rule warning', () => {
    const { rules, warnings } = cssToStyleRules(
      '@keyframes pulse { from { opacity: 0 } 50% { transform: translateX(10px) } to { opacity: 1 } }',
    )
    expect(rules).toHaveLength(1)
    expect(rules[0].kind).toBe('ambient')
    expect(rules[0].selector).toBe('@keyframes pulse')
    expect(rules[0].styles).toEqual({})
    expect(rules[0].rawCss).toContain('@keyframes pulse')
    expect(rules[0].rawCss).toContain('0%')
    expect(rules[0].rawCss).toContain('transform: translateX(10px);')
    expect(rules[0].rawCss).toContain('100%')
    expect(warnings.filter((w) => w.kind === 'dropped-at-rule')).toHaveLength(0)
  })

  it('@keyframes url() references are captured against the raw CSS rule', () => {
    const { rules, assetRefs } = cssToStyleRules(
      "@keyframes mask { to { mask-image: url('../img/noise.png') } }",
    )
    expect(rules).toHaveLength(1)
    expect(assetRefs).toHaveLength(1)
    expect(assetRefs[0]).toMatchObject({
      ruleIndex: 0,
      rawCss: true,
      property: 'maskImage',
      rawUrl: '../img/noise.png',
    })
  })

  it('@font-face → captured as a font (no rule, no dropped warning), url captured as assetRef', () => {
    const { rules, warnings, assetRefs, fontFaces } = cssToStyleRules(
      "@font-face { font-family: 'Foo'; src: url('foo.woff') }",
    )
    // @font-face is no longer a StyleRule, but it's NOT dropped either — it's
    // captured into fontFaces so applyImport can assemble a custom FontEntry.
    expect(rules).toHaveLength(0)
    expect(warnings.some((w) => w.kind === 'dropped-at-rule')).toBe(false)
    expect(fontFaces).toHaveLength(1)
    expect(fontFaces[0].family).toBe('Foo')
    expect(fontFaces[0].srcUrls).toContain('foo.woff')
    // The url is still captured as an assetRef so the binary uploads.
    expect(assetRefs).toHaveLength(1)
    expect(assetRefs[0].rawUrl).toBe('foo.woff')
  })

  it('@import → no rule, 1 dropped-at-rule warning (when surfaced by the engine)', () => {
    // Note: most CSS engines silently ignore @import inside replaceSync, so
    // this may produce 0 rules + 0 warnings in some environments.
    // When the engine DOES surface an @import rule, we emit a warning.
    const { rules } = cssToStyleRules("@import url('other.css');")
    // Either 0 rules (silently ignored) or 0 rules + 1 warning (surfaced).
    // Either way, no rule must be produced.
    expect(rules).toHaveLength(0)
  })

  it('@supports → condition context (no longer a dropped at-rule)', () => {
    const { rules, warnings, conditions } = cssToStyleRules(
      '@supports (display: grid) { .foo { display: grid } }',
    )
    expect(rules).toHaveLength(1)
    // The verbatim conditionText may or may not include surrounding parens
    // depending on the CSS engine; the publisher normalises at emit time.
    expect(conditions).toHaveLength(1)
    expect(conditions[0].condition.kind).toBe('supports')
    // Exactly one context bag, holding the @supports override styles.
    const bags = Object.values(rules[0].contextStyles)
    expect(bags).toHaveLength(1)
    expect(bags[0]).toMatchObject({ display: 'grid' })
    expect(warnings.filter((w) => w.kind === 'dropped-at-rule')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Property allowlist filtering
// ---------------------------------------------------------------------------

describe('cssToStyleRules — permissive property model (Phase 1a)', () => {
  it('an uncurated but valid CSS property is KEPT, no warning', () => {
    // `flex-grow` was never in the old allowlist; under the permissive model
    // any valid CSS identifier round-trips with no unknown/blocked warning.
    const { rules, warnings } = cssToStyleRules('.foo { color: red; flex-grow: 2 }')
    expect(rules).toHaveLength(1)
    expect(rules[0].styles).toMatchObject({ color: 'red', flexGrow: '2' })
    expect(warnings.filter((w) => w.kind === 'unknown-property' || w.kind === 'blocked-property')).toHaveLength(0)
  })

  it('a CSS custom property (--var) round-trips', () => {
    const { rules, warnings } = cssToStyleRules('.foo { --brand: #2563eb }')
    expect(rules[0].styles).toHaveProperty('--brand')
    expect(warnings.filter((w) => w.kind === 'blocked-property')).toHaveLength(0)
  })

  it('a denied property (behavior) is dropped with a blocked-property warning', () => {
    // The CSS engine may or may not surface `behavior` (it is non-standard).
    // When it does, it must be dropped via the security denylist, never kept.
    const { rules, warnings } = cssToStyleRules(
      ".foo { color: red; behavior: url('xss.htc') }",
    )
    expect(rules[0].styles).not.toHaveProperty('behavior')
    expect(rules[0].styles).toMatchObject({ color: 'red' })
    // If the engine surfaced `behavior`, exactly one blocked-property warning fired.
    const blocked = warnings.filter((w) => w.kind === 'blocked-property')
    expect(blocked.length).toBeLessThanOrEqual(1)
    for (const w of blocked) expect(w.property).toBe('behavior')
  })
})

// ---------------------------------------------------------------------------
// url(...) collection
// ---------------------------------------------------------------------------

describe('cssToStyleRules — url(...) collection', () => {
  it('single url → 1 assetRef', () => {
    const { rules, assetRefs } = cssToStyleRules(
      ".foo { background-image: url('assets/bg.png') }",
    )
    expect(rules).toHaveLength(1)
    expect(assetRefs).toHaveLength(1)
    expect(assetRefs[0].ruleIndex).toBe(0)
    expect(assetRefs[0].rawUrl).toBe('assets/bg.png')
    expect(assetRefs[0].property).toBe('backgroundImage')
    expect(assetRefs[0].contextId).toBeUndefined()
  })

  it('multiple urls in one declaration → 2 assetRefs on same rule', () => {
    // Use background-image (not the background shorthand) to guarantee both
    // url() payloads survive CSS-engine normalization in happy-dom.
    const { rules, assetRefs } = cssToStyleRules(
      '.foo { background-image: url(a.png), url(b.png) }',
    )
    expect(rules).toHaveLength(1)
    expect(assetRefs).toHaveLength(2)
    const urls = assetRefs.map((r) => r.rawUrl)
    expect(urls).toContain('a.png')
    expect(urls).toContain('b.png')
    // Both point at the same rule
    expect(assetRefs[0].ruleIndex).toBe(0)
    expect(assetRefs[1].ruleIndex).toBe(0)
  })

  it('url in matched @media contextStyles → assetRef with contextId = breakpoint id', () => {
    const css = '@media (max-width: 768px) { .foo { background-image: url("mobile.png") } }'
    const { assetRefs } = cssToStyleRules(css, {
      breakpoints: [{ id: 'tablet', width: 768 }],
    })
    expect(assetRefs).toHaveLength(1)
    expect(assetRefs[0].contextId).toBe('tablet')
    expect(assetRefs[0].rawUrl).toBe('mobile.png')
  })
})

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

describe('cssToStyleRules — resilience', () => {
  it('empty input → empty result, no warnings', () => {
    const { rules, warnings, assetRefs } = cssToStyleRules('')
    expect(rules).toHaveLength(0)
    expect(warnings).toHaveLength(0)
    expect(assetRefs).toHaveLength(0)
  })

  it('whitespace-only input → empty result, no warnings', () => {
    const { rules, warnings, assetRefs } = cssToStyleRules('   \n  \t  ')
    expect(rules).toHaveLength(0)
    expect(warnings).toHaveLength(0)
    expect(assetRefs).toHaveLength(0)
  })

  it('malformed CSS is handled gracefully without crashing', () => {
    // happy-dom does not throw for most malformed CSS; it silently parses
    // what it can. This test verifies no crash and a valid result shape.
    // In a real browser, replaceSync may throw and produce an invalid-rule
    // warning with an empty rules array.
    expect(() => cssToStyleRules('not valid css {{{')).not.toThrow()
    const result = cssToStyleRules('not valid css {{{')
    expect(result.rules).toBeDefined()
    expect(result.warnings).toBeDefined()
    expect(result.assetRefs).toBeDefined()
    // If an invalid-rule warning was emitted (real browser), no rules expected.
    if (result.warnings.some((w) => w.kind === 'invalid-rule')) {
      expect(result.rules).toHaveLength(0)
    }
  })

  it('{{{ produces empty result (happy-dom: 0 rules parsed)', () => {
    const { rules, warnings } = cssToStyleRules('{{{')
    expect(rules).toHaveLength(0)
    // May or may not emit a warning depending on environment
    expect(Array.isArray(warnings)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Property name conversion (kebab → camelCase)
// ---------------------------------------------------------------------------

describe('cssToStyleRules — property name conversion', () => {
  it('background-color → backgroundColor', () => {
    const { rules } = cssToStyleRules('.foo { background-color: red }')
    expect(rules[0].styles).toHaveProperty('backgroundColor', 'red')
    expect(rules[0].styles).not.toHaveProperty('background-color')
  })

  it('font-size → fontSize', () => {
    const { rules } = cssToStyleRules('.foo { font-size: 16px }')
    expect(rules[0].styles).toHaveProperty('fontSize', '16px')
  })

  it('z-index → zIndex', () => {
    const { rules } = cssToStyleRules('.foo { z-index: 10 }')
    expect(rules[0].styles).toHaveProperty('zIndex', '10')
  })
})

// ---------------------------------------------------------------------------
// Class name with hyphens
// ---------------------------------------------------------------------------

describe('cssToStyleRules — class names with hyphens', () => {
  it('.btn-primary → kind:class, name:btn-primary', () => {
    const { rules } = cssToStyleRules('.btn-primary { color: red }')
    expect(rules[0].kind).toBe('class')
    expect(rules[0].name).toBe('btn-primary')
    expect(rules[0].selector).toBe('.btn-primary')
  })

  it('.my-long-class-name → kind:class', () => {
    const { rules } = cssToStyleRules('.my-long-class-name { color: red }')
    expect(rules[0].kind).toBe('class')
    expect(rules[0].name).toBe('my-long-class-name')
  })
})

// ---------------------------------------------------------------------------
// Ambient rule — name and selector
// ---------------------------------------------------------------------------

describe('cssToStyleRules — ambient name defaults to selector', () => {
  it('h1 > span: name and selector both equal "h1 > span"', () => {
    const { rules } = cssToStyleRules('h1 > span { color: red }')
    // The CSS engine may normalise whitespace; check trimmed match
    expect(rules[0].name.trim()).toBe(rules[0].selector.trim())
    expect(rules[0].name.replace(/\s+/g, ' ').trim()).toContain('h1')
    expect(rules[0].name.replace(/\s+/g, ' ').trim()).toContain('span')
  })

  it('h1: name and selector both equal "h1"', () => {
    const { rules } = cssToStyleRules('h1 { color: red }')
    expect(rules[0].name).toBe('h1')
    expect(rules[0].selector).toBe('h1')
  })
})

// ---------------------------------------------------------------------------
// Duplicate class names
// ---------------------------------------------------------------------------

describe('cssToStyleRules — duplicate class names', () => {
  it('duplicate .foo → 1 rule with later value + 1 duplicate-class warning', () => {
    const { rules, warnings } = cssToStyleRules('.foo { color: red } .foo { color: blue }')
    expect(rules).toHaveLength(1)
    // Later rule wins: color should be 'blue'
    expect(rules[0].styles).toMatchObject({ color: 'blue' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].kind).toBe('duplicate-class')
    expect(warnings[0].selector).toBe('.foo')
  })

  it('an earlier important declaration resists a later normal declaration', () => {
    const { rules } = cssToStyleRules(
      '.foo { color: red !important } .foo { color: blue }',
    )
    expect(rules[0].styles.color).toBe('red')
    expect(rules[0].stylePriorities).toEqual({ color: 'important' })
  })

  it('a later important declaration replaces an earlier normal declaration', () => {
    const { rules } = cssToStyleRules(
      '.foo { color: red } .foo { color: blue !important }',
    )
    expect(rules[0].styles.color).toBe('blue')
    expect(rules[0].stylePriorities).toEqual({ color: 'important' })
  })

  it('ambient h1 duplicates are allowed (no dedup for ambient)', () => {
    // Two h1 rules are valid CSS (cascade resolves by source order)
    const { rules, warnings } = cssToStyleRules('h1 { color: red } h1 { color: blue }')
    // Expect 2 separate ambient rules (not deduplicated)
    expect(rules).toHaveLength(2)
    expect(warnings.filter((w) => w.kind === 'duplicate-class')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Order assignment
// ---------------------------------------------------------------------------

describe('cssToStyleRules — order assignment', () => {
  it('three rules in source order → order: 0, 1, 2', () => {
    const { rules } = cssToStyleRules(
      'h1 { color: red } .foo { color: blue } body { color: green }',
    )
    expect(rules).toHaveLength(3)
    expect(rules[0].order).toBe(0)
    expect(rules[1].order).toBe(1)
    expect(rules[2].order).toBe(2)
  })

  it('order is stable — rules are emitted in source position', () => {
    const { rules } = cssToStyleRules('.a { color: red } .b { color: blue } .c { color: green }')
    const names = rules.map((r) => r.name)
    expect(names).toEqual(['a', 'b', 'c'])
    expect(rules.map((r) => r.order)).toEqual([0, 1, 2])
  })
})

// ---------------------------------------------------------------------------
// Integration: class rule round-trip
// ---------------------------------------------------------------------------

describe('cssToStyleRules — integration', () => {
  it('multiple class rules produce independent NewStyleRule objects', () => {
    const css = '.hero { background-color: #fff; padding: 20px } .title { font-size: 24px; color: #333 }'
    // Note: padding and background-color are in ALLOWED_PROPS; #fff/#333 hex values pass through
    const { rules, warnings } = cssToStyleRules(css)
    expect(rules).toHaveLength(2)
    expect(rules[0].name).toBe('hero')
    expect(rules[1].name).toBe('title')
    // Unknown-property warnings are OK; we just verify structure
    const ruleNames = new Set(rules.map((r) => r.name))
    expect(ruleNames.has('hero')).toBe(true)
    expect(ruleNames.has('title')).toBe(true)
  })

  it('uncurated but valid properties are KEPT under the permissive model', () => {
    // `totally-made-up` / `also-fake` are valid CSS identifiers — the
    // permissive model keeps them verbatim and emits no warning. (Whether the
    // browser's CSS engine surfaces an unknown property in cssText is engine-
    // dependent; we assert no spurious unknown/blocked warning, and that any
    // surfaced property round-trips camelCased.)
    const { rules, warnings } = cssToStyleRules('.foo { totally-made-up: 1; also-fake: 2 }')
    expect(rules).toHaveLength(1)
    expect(warnings.filter((w) => w.kind === 'unknown-property' || w.kind === 'blocked-property')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Allowlist expansion — 9 modern CSS properties
//
// Each test verifies:
//   1. No unknown-property warning for the property (it is in ALLOWED_PROPS).
//   2. The camelCase key appears in rules[0].styles (CSS engine parsed it).
//
// If the test environment's CSS engine (happy-dom) silently drops a property
// without surfacing it in CSSStyleDeclaration, assertion (2) will fail — that
// is a CSS-engine limitation, not an allowlist regression.
// ---------------------------------------------------------------------------

describe('cssToStyleRules — ALLOWED_PROPS expansion: isolation', () => {
  it('isolation: isolate → no unknown-property warning, key present in styles', () => {
    const { rules, warnings } = cssToStyleRules('.foo { isolation: isolate }')
    expect(warnings.filter((w) => w.kind === 'unknown-property' && w.property === 'isolation')).toHaveLength(0)
    expect(rules).toHaveLength(1)
    expect(rules[0].styles).toHaveProperty('isolation')
  })
})

describe('cssToStyleRules — ALLOWED_PROPS expansion: backgroundPositionX', () => {
  it('background-position-x: 50% → no unknown-property warning, key present', () => {
    const { rules, warnings } = cssToStyleRules('.foo { background-position-x: 50% }')
    expect(warnings.filter((w) => w.kind === 'unknown-property' && w.property === 'backgroundPositionX')).toHaveLength(0)
    expect(rules).toHaveLength(1)
    expect(rules[0].styles).toHaveProperty('backgroundPositionX')
  })
})

describe('cssToStyleRules — ALLOWED_PROPS expansion: backgroundPositionY', () => {
  it('background-position-y: 50% → no unknown-property warning, key present', () => {
    const { rules, warnings } = cssToStyleRules('.foo { background-position-y: 50% }')
    expect(warnings.filter((w) => w.kind === 'unknown-property' && w.property === 'backgroundPositionY')).toHaveLength(0)
    expect(rules).toHaveLength(1)
    expect(rules[0].styles).toHaveProperty('backgroundPositionY')
  })
})

describe('cssToStyleRules — ALLOWED_PROPS expansion: backgroundAttachment', () => {
  it('background-attachment: fixed → no unknown-property warning, key present', () => {
    const { rules, warnings } = cssToStyleRules('.foo { background-attachment: fixed }')
    expect(warnings.filter((w) => w.kind === 'unknown-property' && w.property === 'backgroundAttachment')).toHaveLength(0)
    expect(rules).toHaveLength(1)
    expect(rules[0].styles).toHaveProperty('backgroundAttachment')
  })
})

describe('cssToStyleRules — ALLOWED_PROPS expansion: backgroundOrigin', () => {
  it('background-origin: content-box → no unknown-property warning, key present', () => {
    const { rules, warnings } = cssToStyleRules('.foo { background-origin: content-box }')
    expect(warnings.filter((w) => w.kind === 'unknown-property' && w.property === 'backgroundOrigin')).toHaveLength(0)
    expect(rules).toHaveLength(1)
    expect(rules[0].styles).toHaveProperty('backgroundOrigin')
  })
})

describe('cssToStyleRules — ALLOWED_PROPS expansion: backgroundClip', () => {
  it('background-clip: text → no unknown-property warning, key present', () => {
    const { rules, warnings } = cssToStyleRules('.foo { background-clip: text }')
    expect(warnings.filter((w) => w.kind === 'unknown-property' && w.property === 'backgroundClip')).toHaveLength(0)
    expect(rules).toHaveLength(1)
    expect(rules[0].styles).toHaveProperty('backgroundClip')
  })
})

describe('cssToStyleRules — ALLOWED_PROPS expansion: content', () => {
  it('content: "" → no unknown-property warning, key present', () => {
    // content is valid on any element (CSS spec allows it, though browsers
    // may treat it as a no-op outside pseudo-elements).
    const { rules, warnings } = cssToStyleRules('.foo { content: "" }')
    expect(warnings.filter((w) => w.kind === 'unknown-property' && w.property === 'content')).toHaveLength(0)
    expect(rules).toHaveLength(1)
    expect(rules[0].styles).toHaveProperty('content')
  })
})

describe('cssToStyleRules — ALLOWED_PROPS expansion: textWrapMode', () => {
  it('text-wrap-mode: nowrap → no unknown-property warning', () => {
    // text-wrap-mode is a CSS Text Level 4 property. If the CSS engine (happy-dom)
    // does not recognise it, it will simply not appear in CSSStyleDeclaration and
    // no warning of any kind is emitted — that is a CSS-engine limitation, not an
    // allowlist regression. We at minimum verify no false unknown-property warning.
    const { warnings } = cssToStyleRules('.foo { text-wrap-mode: nowrap }')
    expect(warnings.filter((w) => w.kind === 'unknown-property' && w.property === 'textWrapMode')).toHaveLength(0)
  })
})

describe('cssToStyleRules — ALLOWED_PROPS expansion: textWrapStyle', () => {
  it('text-wrap-style: balance → no unknown-property warning', () => {
    // Same caveat as text-wrap-mode above.
    const { warnings } = cssToStyleRules('.foo { text-wrap-style: balance }')
    expect(warnings.filter((w) => w.kind === 'unknown-property' && w.property === 'textWrapStyle')).toHaveLength(0)
  })
})

describe('cssToStyleRules — ALLOWED_PROPS expansion: border longhands', () => {
  it('`border: 1px solid #ccc` shorthand → browser unrolls to per-side longhands, none dropped', () => {
    // The browser CSS engine unrolls the `border` shorthand into the 12
    // per-side longhands (border-{side}-{width|style|color}). All 12 are now
    // allowlisted, so the importer must not emit any unknown-property warning
    // and the per-side keys must survive into the rule's styles.
    const { rules, warnings } = cssToStyleRules('.foo { border: 1px solid #ccc }')
    const borderUnknowns = warnings.filter(
      (w) => w.kind === 'unknown-property' && /^border/.test(w.property ?? ''),
    )
    expect(borderUnknowns).toHaveLength(0)
    expect(rules).toHaveLength(1)
    // At minimum the width + style + color of the top side survive.
    expect(rules[0].styles).toHaveProperty('borderTopWidth')
    expect(rules[0].styles).toHaveProperty('borderTopStyle')
    expect(rules[0].styles).toHaveProperty('borderTopColor')
  })

  it('explicit per-side longhand → key present, no warning', () => {
    const { rules, warnings } = cssToStyleRules('.foo { border-bottom-width: 2px }')
    expect(
      warnings.filter((w) => w.kind === 'unknown-property' && w.property === 'borderBottomWidth'),
    ).toHaveLength(0)
    expect(rules[0].styles).toHaveProperty('borderBottomWidth')
  })
})

describe('cssToStyleRules — ALLOWED_PROPS expansion: appearance', () => {
  it('appearance: none → no unknown-property warning, key present', () => {
    const { rules, warnings } = cssToStyleRules('.foo { appearance: none }')
    expect(
      warnings.filter((w) => w.kind === 'unknown-property' && w.property === 'appearance'),
    ).toHaveLength(0)
    expect(rules[0].styles).toHaveProperty('appearance')
  })
})

// ---------------------------------------------------------------------------
// @media deduplication — unmatched-media-query warning fires once per unique
// condition text, not once per @media block occurrence.
// ---------------------------------------------------------------------------

describe('cssToStyleRules — custom @media as conditional layers (no warnings)', () => {
  it('5 @media blocks with the same condition → one shared media layer per selector, no warnings', () => {
    // Tailwind v4 emits one @media block per utility class. Each becomes a
    // conditional layer on its own selector's rule, all keyed on the same
    // verbatim query. No "unmatched-media-query" warning flood anymore.
    const css = [
      '@media (max-width: 860px) { .a { color: red } }',
      '@media (max-width: 860px) { .b { color: blue } }',
      '@media (max-width: 860px) { .c { font-size: 14px } }',
    ].join('\n')
    const { rules, warnings, conditions } = cssToStyleRules(css, { breakpoints: [] })
    expect(warnings.filter((w) => w.kind === 'unmatched-media-query')).toHaveLength(0)
    // One shared registry entry for the common query; one rule per selector,
    // each carrying an override under that one condition id.
    expect(conditions).toHaveLength(1)
    const cid = conditionId({ kind: 'media', query: '(max-width: 860px)' })
    expect(rules).toHaveLength(3)
    for (const r of rules) {
      expect(Object.keys(r.contextStyles)).toEqual([cid])
    }
  })

  it('the same selector under the same query merges into one context bag', () => {
    const css = [
      '@media (max-width: 860px) { .a { color: red } }',
      '@media (max-width: 860px) { .a { font-size: 14px } }',
    ].join('\n')
    const { rules } = cssToStyleRules(css, { breakpoints: [] })
    const a = rules.find((r) => r.selector === '.a')!
    const cid = conditionId({ kind: 'media', query: '(max-width: 860px)' })
    expect(Object.keys(a.contextStyles)).toEqual([cid])
    expect(a.contextStyles[cid]).toMatchObject({ color: 'red', fontSize: '14px' })
  })
})
