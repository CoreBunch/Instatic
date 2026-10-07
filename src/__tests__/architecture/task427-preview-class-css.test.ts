/**
 * Task #427 — Preview CSS: "I press preview; it opens the preview, but it seems
 * it doesn't load the CSS from classes I use."
 *
 * ── Root cause analysis ─────────────────────────────────────────────────────
 * Three defects block reliable testing (and likely underlie the user-visible bug):
 *
 *   Bug A — `makePage()` helper ignores `classIds` in NodeSpec
 *     The shared test helper constructs PageNode objects without copying the
 *     `classIds` field from the spec.  Any test that builds a node via
 *     `makePage({ btn: { moduleId: 'base.button', classIds: ['x'] } })` will
 *     produce a node with `classIds: undefined`, silently bypassing the entire
 *     CSS class pipeline in `publishPage`.
 *
 *   Bug B — `makeSite()` helper missing `classes: {}` default
 *     Projects created via `makeSite()` have `site.styleRules = undefined` unless
 *     overridden.  In `collectClassCSS(site)`, if any node has classIds AND
 *     `site.styleRules` is undefined, the `site.styleRules[id]` read throws:
 *       TypeError: Cannot read properties of undefined (reading '<classId>')
 *     This turns any legitimate "preview with classes" scenario into an unhandled
 *     crash in the test environment — the very path the user is hitting.
 *
 *   Bug C — Zero end-to-end test coverage for class CSS in published HTML
 *     `render.test.ts` has no test that verifies `publishPage()` embeds
 *     `.{className} { … }` in the `<style>` block, nor that the root element
 *     of a published node carries `class="{className}"`.  The publisher can
 *     silently lose class CSS with no failing signal.
 *
 * ── Gate plan ────────────────────────────────────────────────────────────────
 *   Gate 1 (Bug A)    — makePage preserves classIds from NodeSpec
 *   Gate 2 (Bug B)    — makeSite includes classes default
 *   Gate 3 (Bug B2)   — collectClassCSS does NOT crash when site.styleRules is missing
 *   Gate 4 (Bug C)    — publishPage embeds .{className} CSS rule in <style> block
 *   Gate 5 (Bug C)    — publishPage injects class="{className}" on the rendered element
 *   Gate 6 (Combined) — full path via makePage helper: classIds survive to HTML output
 *   Gate 7 (Combined) — multiple classIds: all CSS rules present, all on element
 *   Gate 8 (Combined) — breakpoint override emits @media block in published HTML
 *
 * These gates now act as regression coverage for the publisher class CSS path.
 *
 * @see src/__tests__/publisher/helpers.ts        — makePage / makeSite (needs fix)
 * @see src/core/publisher/render.ts              — publishPage, renderNode
 * @see src/core/publisher/cssCollector.ts        — collectClassCSS
 * @see src/admin/pages/site/components/Canvas/ClassStyleInjector.tsx — generateClassCSS, bagToCSS
 */

import { describe, it, expect } from 'bun:test'
import { collectClassCSS, publishPage } from '@core/publisher'
import { classKindSelector, type Page, type PageNode, type SiteDocument, type StyleRule } from '@core/page-tree'
import { makeModule, makeRegistry, makePage, makeSite } from '../publisher/helpers'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeClass(id: string, styles: StyleRule['styles'] = {}): StyleRule {
  return {
    id,
    name: id,
    kind: 'class',
    selector: classKindSelector(id),
    order: 0,
    styles,
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

/** Minimal registry used across integration gates */
const rootModule = makeModule('base.body', {
  canHaveChildren: true,
  render: (_props, children) => ({ html: children.join('') }),
})

const buttonModule = makeModule('base.button', {
  canHaveChildren: false,
  render: () => ({ html: '<button class="instatic-btn">Click me</button>' }),
})

const headingModule = makeModule('base.text', {
  canHaveChildren: false,
  render: (props) => ({
    html: `<h2 class="instatic-heading">${props['text'] ?? ''}</h2>`,
    css: '.instatic-heading { font-size: 1.5rem; }',
  }),
})

const reg = makeRegistry({
  'base.body': rootModule,
  'base.button': buttonModule,
  'base.text': headingModule,
})

/** Build a minimal Page directly (bypasses makePage) so gates 4/5/7/8 test
 *  the publisher itself rather than the helper.
 */
function directPage(nodeClassIds: string[]): Page {
  const root: PageNode = {
    id: 'root',
    moduleId: 'base.body',
    props: {},
    children: ['btn'],
    breakpointOverrides: {},
    classIds: [],
  }
  const btn: PageNode = {
    id: 'btn',
    moduleId: 'base.button',
    props: {},
    children: [],
    breakpointOverrides: {},
    classIds: nodeClassIds,
  }
  return {
    id: 'page-1',
    slug: 'index',
    title: 'Home',
    rootNodeId: 'root',
    nodes: { root, btn },
  }
}

/** Build a minimal SiteDocument directly (bypasses makeSite) */
function directSite(page: Page, styleRules: SiteDocument['styleRules'] = {}): SiteDocument {
  return {
    id: 'proj-1',
    name: 'Test',
    pages: [page],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { colorTokens: {}, shortcuts: {} },
    styleRules,
    files: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

// ---------------------------------------------------------------------------
// Gate 1 — Bug A: makePage helper must pass classIds to nodes
// ─────────────────────────────────────────────────────────────────────────────
// Regression:
//   makePage() must construct PageNode objects with classIds preserved from
//   the spec so publisher tests exercise the class CSS pipeline.
// ---------------------------------------------------------------------------

describe('Gate 1 — makePage helper passes classIds to generated nodes', () => {
  it('Gate1a: makePage assigns a non-empty classIds array to the node', () => {
    const classId = 'hero-abc'
    const page = makePage(
      {
        root: { moduleId: 'base.body', children: ['btn'] },
        btn: { moduleId: 'base.button', classIds: [classId] },
      },
      'root',
    )
    expect(page.nodes['btn'].classIds).toEqual([classId])
  })

  it('Gate1b: makePage passes empty classIds array when none specified', () => {
    const page = makePage({ root: { moduleId: 'base.body' } }, 'root')
    expect(page.nodes['root'].classIds).toEqual([])
  })

  it('Gate1c: makePage passes multiple classIds correctly', () => {
    const ids = ['cls-1', 'cls-2', 'cls-3']
    const page = makePage(
      { root: { moduleId: 'base.body', classIds: ids } },
      'root',
    )
    expect(page.nodes['root'].classIds).toEqual(ids)
  })
})

// ---------------------------------------------------------------------------
// Gate 2 — Bug B: makeSite helper must include classes default
// ─────────────────────────────────────────────────────────────────────────────
// Regression:
//   makeSite() must provide a classes object by default so class CSS tests
//   don't accidentally construct invalid fixture documents.
// ---------------------------------------------------------------------------

describe('Gate 2 — makeSite helper provides classes default', () => {
  it('Gate2a: makeSite() result has classes defined (not undefined)', () => {
    const site = makeSite()
    expect(site.styleRules).toBeDefined()
    expect(typeof site.styleRules).toBe('object')
    expect(Array.isArray(site.styleRules)).toBe(false)
  })

  it('Gate2c: makeSite() classes default is an empty object', () => {
    const site = makeSite()
    expect(Object.keys(site.styleRules)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Gate 3 — Bug B2: collectClassCSS must not crash when site.styleRules is missing
// ─────────────────────────────────────────────────────────────────────────────
// Regression:
//   collectClassCSS should degrade gracefully if a partial/corrupt snapshot has
//   nodes with classIds but no classes registry.
// ---------------------------------------------------------------------------

describe('Gate 3 — collectClassCSS is defensive against missing site.styleRules', () => {
  it('Gate3: does not throw when site.styleRules is undefined but nodes have classIds', () => {
    // Construct a site where classes is explicitly missing.
    const page: Page = {
      id: 'p1', slug: 'index', title: 'Home', rootNodeId: 'root',
      nodes: {
        root: {
          id: 'root', moduleId: 'base.body', props: {}, children: [],
          breakpointOverrides: {}, classIds: ['orphan-class-id'],
        },
      },
    }
    const brokenSite = {
      id: 'proj1', name: 'Test',
      pages: [page],
      breakpoints: [],
      settings: { colorTokens: {}, shortcuts: {} },
      classes: undefined as unknown as SiteDocument['classes'],  // simulates the makeSite() gap
      createdAt: 0, updatedAt: 0,
    }
    // Should NOT throw — should return '' gracefully
    expect(() => collectClassCSS(brokenSite)).not.toThrow()
    expect(collectClassCSS(brokenSite)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Gates 4 & 5 — Bug C: publishPage must embed class CSS in <style> and inject
//               class attribute on the HTML element (direct construction path)
// ─────────────────────────────────────────────────────────────────────────────
// These tests use directPage() / directSite() to bypass the broken makeSite
// and makePage helpers — they test the PUBLISHER code itself.
//
// If these tests start failing after a refactor, the publisher pipeline is broken.
// ---------------------------------------------------------------------------

describe('Gate 4 — publishPage embeds class CSS in <style> block (direct construction)', () => {
  const classId = 'hero-xyz'

  it('Gate4a: <style> block contains the user class name CSS rule', () => {
    const page = directPage([classId])
    const site = directSite(page, {
      [classId]: makeClass(classId, { backgroundColor: '#ff0000' }),
    })
    const { html } = publishPage(page, site, reg)
    expect(html).toContain(`.${classId}`)
  })

  it('Gate4b: <style> block contains the correct CSS property', () => {
    const page = directPage([classId])
    const site = directSite(page, {
      [classId]: makeClass(classId, { backgroundColor: '#ff0000' }),
    })
    const { html } = publishPage(page, site, reg)
    expect(html).toContain('background-color: #ff0000')
  })

  it('Gate4c: class CSS appears inside the <style> tag, not the <body>', () => {
    const page = directPage([classId])
    const site = directSite(page, {
      [classId]: makeClass(classId, { color: 'red' }),
    })
    const { html } = publishPage(page, site, reg)
    const styleBlockMatch = html.match(/<style>([\s\S]*?)<\/style>/)
    expect(styleBlockMatch).not.toBeNull()
    const styleContent = styleBlockMatch![1]
    expect(styleContent).toContain(`.${classId}`)
  })

  it('Gate4d: unused classes are NOT emitted in the style block (tree-shaking)', () => {
    const usedId = 'used-cls'
    const unusedId = 'unused-cls'
    const page = directPage([usedId]) // only usedId on the node
    const site = directSite(page, {
      [usedId]: makeClass(usedId, { color: 'green' }),
      [unusedId]: makeClass(unusedId, { color: 'red' }),
    })
    const { html } = publishPage(page, site, reg)
    expect(html).toContain(`.${usedId}`)
    expect(html).not.toContain(`.${unusedId}`)
  })
})

describe('Gate 5 — publishPage injects user class name attribute on rendered element', () => {
  const classId = 'btn-style'

  it('Gate5a: rendered HTML element carries class="{className}"', () => {
    const page = directPage([classId])
    const site = directSite(page, {
      [classId]: makeClass(classId, { color: 'blue' }),
    })
    const { html } = publishPage(page, site, reg)
    expect(html).toContain(classId)
  })

  it('Gate5b: user class name appears on the <button> element, not a wrapper', () => {
    const page = directPage([classId])
    const site = directSite(page, {
      [classId]: makeClass(classId, { color: 'blue' }),
    })
    const { html } = publishPage(page, site, reg)
    // The button module renders <button class="instatic-btn">; user class should be prepended
    expect(html).toMatch(new RegExp(`<button[^>]*class="${classId}`))
  })

  it('Gate5c: node with NO classIds produces no generated class prefix on element', () => {
    const page = directPage([]) // no classIds
    const site = directSite(page)
    const { html } = publishPage(page, site, reg)
    expect(html).not.toContain('mc-')
  })
})

// ---------------------------------------------------------------------------
// Gate 6 — Combined: full path using makePage helper must preserve classIds
// ─────────────────────────────────────────────────────────────────────────────
// This is the critical integration test: the complete happy-path
// "create a node via makePage with classIds → publishPage includes class CSS"
// must work correctly for the preview to show class styles.
// ---------------------------------------------------------------------------

describe('Gate 6 — publishPage full path via makePage helper', () => {
  const classId = 'hero-full'

  it('Gate6a: publishPage includes class CSS when node has classIds set via makePage', () => {
    const page = makePage(
      {
        root: { moduleId: 'base.body', children: ['btn'] },
        btn: { moduleId: 'base.button', classIds: [classId] },
      },
      'root',
    )
    const site = makeSite({
      pages: [page],
      styleRules: { [classId]: makeClass(classId, { backgroundColor: 'blue' }) },
    })
    const { html } = publishPage(page, site, reg)
    expect(html).toContain(`.${classId}`)
    expect(html).toContain('background-color: blue')
  })

  it('Gate6b: HTML element has user class name when classIds set via makePage', () => {
    const page = makePage(
      {
        root: { moduleId: 'base.body', children: ['btn'] },
        btn: { moduleId: 'base.button', classIds: [classId] },
      },
      'root',
    )
    const site = makeSite({
      pages: [page],
      styleRules: { [classId]: makeClass(classId, { color: 'white' }) },
    })
    const { html } = publishPage(page, site, reg)
    expect(html).toContain(classId)
  })
})

// ---------------------------------------------------------------------------
// Gate 7 — Multiple classIds: all CSS rules + all class names on element
// ─────────────────────────────────────────────────────────────────────────────
// Regression guard for multi-class support.
// ---------------------------------------------------------------------------

describe('Gate 7 — multiple classIds produce all CSS rules and class names', () => {
  it('Gate7a: all CSS rules appear in <style> block', () => {
    const ids = ['cls-a', 'cls-b', 'cls-c']
    const page = directPage(ids)
    const site = directSite(page, {
      'cls-a': makeClass('cls-a', { color: 'red' }),
      'cls-b': makeClass('cls-b', { fontWeight: 'bold' }),
      'cls-c': makeClass('cls-c', { fontSize: '1.2rem' }),
    })
    const { html } = publishPage(page, site, reg)
    for (const id of ids) {
      expect(html).toContain(`.${id}`)
    }
  })

  it('Gate7b: all class names appear on the rendered element', () => {
    const ids = ['cls-a', 'cls-b', 'cls-c']
    const page = directPage(ids)
    const site = directSite(page, {
      'cls-a': makeClass('cls-a', { color: 'red' }),
      'cls-b': makeClass('cls-b', { fontWeight: 'bold' }),
      'cls-c': makeClass('cls-c', { fontSize: '1.2rem' }),
    })
    const { html } = publishPage(page, site, reg)
    for (const id of ids) {
      expect(html).toContain(id)
    }
  })

  it('Gate7c: class names appear in the declared order on the element', () => {
    const ids = ['first', 'second', 'third']
    const page = directPage(ids)
    const site = directSite(page, {
      first: makeClass('first', { color: 'red' }),
      second: makeClass('second', { color: 'blue' }),
      third: makeClass('third', { color: 'green' }),
    })
    const { html } = publishPage(page, site, reg)
    const firstPos = html.indexOf('first')
    const secondPos = html.indexOf('second')
    const thirdPos = html.indexOf('third')
    // class="first second third" — order must match node.classIds order
    expect(firstPos).toBeLessThan(secondPos)
    expect(secondPos).toBeLessThan(thirdPos)
  })
})

// ---------------------------------------------------------------------------
// Gate 8 — Breakpoint override in class emits @media block in published HTML
// ─────────────────────────────────────────────────────────────────────────────
// Regression guard for responsive class CSS.
// ---------------------------------------------------------------------------

describe('Gate 8 — class breakpoint overrides emit @media blocks in published HTML', () => {
  it('Gate8a: @media block is present for a class with a breakpoint override', () => {
    const classId = 'responsive-cls'
    const bpId = 'mobile'
    const page = directPage([classId])
    const site: SiteDocument = {
      id: 'proj-1', name: 'Test',
      pages: [page],
      files: [],
      breakpoints: [{ id: bpId, label: 'Mobile', width: 375, icon: 'smartphone' }],
      settings: { colorTokens: {}, shortcuts: {} },
      styleRules: {
        [classId]: {
          id: classId, name: classId,
          kind: 'class',
          selector: classKindSelector(classId),
          order: 0,
          styles: { fontSize: '1rem' },
          contextStyles: {
            [bpId]: { fontSize: '0.875rem' },
          },
          createdAt: 0, updatedAt: 0,
        },
      },
      createdAt: 0, updatedAt: 0,
    }
    const { html } = publishPage(page, site, reg)
    // Should contain @media (max-width: 375px) { .{className} { ... } }
    expect(html).toContain('@media')
    expect(html).toContain('375px')
    expect(html).toContain(`.${classId}`)
  })

  it('Gate8b: base class CSS rule is also present alongside the @media block', () => {
    const classId = 'responsive-cls'
    const bpId = 'mobile'
    const page = directPage([classId])
    const site: SiteDocument = {
      id: 'proj-1', name: 'Test',
      pages: [page],
      files: [],
      breakpoints: [{ id: bpId, label: 'Mobile', width: 375, icon: 'smartphone' }],
      settings: { colorTokens: {}, shortcuts: {} },
      styleRules: {
        [classId]: {
          id: classId, name: classId,
          kind: 'class',
          selector: classKindSelector(classId),
          order: 0,
          styles: { color: 'black' },
          contextStyles: { [bpId]: { color: 'white' } },
          createdAt: 0, updatedAt: 0,
        },
      },
      createdAt: 0, updatedAt: 0,
    }
    const { html } = publishPage(page, site, reg)
    const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) ?? [])[1] ?? ''
    // Both the base rule and the media query must be present
    expect(styleBlock).toContain('color: black')   // base styles
    expect(styleBlock).toContain('color: white')   // breakpoint override
    expect(styleBlock).toContain('@media')
  })
})

// ---------------------------------------------------------------------------
// Summary — regression coverage
// ---------------------------------------------------------------------------
//
// These tests protect the full route from test fixtures through published HTML:
// classIds survive fixture construction, used classes emit CSS by user-facing
// name, and published elements receive the same user-facing class names.
