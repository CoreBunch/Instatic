/**
 * siteCssBundle — unit tests for the server-side CSS bundle builder.
 *
 * Verifies:
 * - The four layered files are produced (reset / framework / style / userStyles).
 * - Each file's content is correctly populated from the corresponding source
 *   (reset constant, framework root + module CSS, user class CSS,
 *   user-authored stylesheets from `site.files`).
 * - Filenames embed a content hash so cache busting works.
 * - Identical sites produce identical hashes (deterministic).
 * - Different sites produce different hashes for the layer that changed.
 */

import { describe, it, expect } from 'bun:test'
import {
  frameworkColorClassId,
  generateFrameworkColorUtilityClasses,
} from '@core/framework'
import { buildSiteCssBundle } from '../../../server/publish/siteCssBundle'
import { makeModule, makeRegistry, makePage, makeSite } from '../publisher/helpers'

describe('buildSiteCssBundle', () => {
  const styledTextDef = makeModule('base.text', {
    render: (_props, _children) => ({
      html: '<h1>Hello</h1>',
      // Plugins MAY emit module CSS via render(); base modules don't, but the
      // bundle builder must handle both. This stand-in proves the path works.
      css: 'h1 { color: black; }',
    }),
  })
  const registry = makeRegistry({ 'base.text': styledTextDef })
  const colorFramework = {
    tokens: [
      {
        id: 'primary-token',
        category: 'Brand',
        slug: 'primary',
        lightValue: 'hsla(238, 100%, 62%, 1)',
        darkValue: 'hsla(238, 100%, 42%, 1)',
        darkModeEnabled: false,
        generateUtilities: { text: true, background: true, border: false, fill: false },
        generateTransparent: false,
        generateShades: { enabled: false, count: 0 },
        generateTints: { enabled: false, count: 0 },
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }

  it('builds four files with sensible filenames + hashes', () => {
    const site = makeSite()
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Hi' } },
    })
    site.pages = [page]

    const bundle = buildSiteCssBundle(site, registry)

    expect(bundle.reset.bundle).toBe('reset')
    expect(bundle.framework.bundle).toBe('framework')
    expect(bundle.style.bundle).toBe('style')
    expect(bundle.userStyles.bundle).toBe('userStyles')

    expect(bundle.reset.filename).toMatch(/^reset-[a-f0-9]{12}\.css$/)
    expect(bundle.framework.filename).toMatch(/^framework-[a-f0-9]{12}\.css$/)
    expect(bundle.style.filename).toMatch(/^style-[a-f0-9]{12}\.css$/)
    expect(bundle.userStyles.filename).toMatch(/^userStyles-[a-f0-9]{12}\.css$/)
  })

  it('reset.css carries the publisher reset content', () => {
    const site = makeSite()
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    site.pages = [page]

    const bundle = buildSiteCssBundle(site, registry)
    expect(bundle.reset.content).toContain(':where(*, *::before, *::after) { box-sizing: border-box; }')
    expect(bundle.reset.content).toContain('font-family: system-ui')
  })

  it('framework.css carries module CSS deduped across pages', () => {
    const site = makeSite()
    // Same module on three pages — its CSS must appear exactly once.
    site.pages = [
      makePage({ id: 'p1', root: { moduleId: 'base.text', props: { text: 'A' } } }),
      makePage({ id: 'p2', root: { moduleId: 'base.text', props: { text: 'B' } } }),
      makePage({ id: 'p3', root: { moduleId: 'base.text', props: { text: 'C' } } }),
    ]

    const bundle = buildSiteCssBundle(site, registry)
    const occurrences = bundle.framework.content.match(/h1 \{ color: black; \}/g) ?? []
    expect(occurrences.length).toBe(1)
  })

  it('style.css carries user class CSS', () => {
    const site = makeSite()
    site.styleRules = {
      hero: {
        id: 'hero',
        name: 'hero',
        kind: 'class',
        selector: '.hero',
        order: 0,
        styles: { fontSize: '48px' },
        contextStyles: {},
        createdAt: 0,
        updatedAt: 0,
      },
    }
    site.pages = [
      makePage({
        root: {
          moduleId: 'base.text',
          props: { text: 'Hi' },
          classIds: ['hero'],
        },
      }),
    ]

    const bundle = buildSiteCssBundle(site, registry)
    expect(bundle.style.content).toContain('.hero')
    expect(bundle.style.content).toContain('font-size: 48px')
  })

  it('framework.css carries generated framework utilities while style.css excludes them', () => {
    const textClassId = frameworkColorClassId('primary-token', 'base', 'text')
    const site = makeSite({
      settings: {
        ...makeSite().settings,
        framework: { colors: colorFramework },
      },
      styleRules: {
        ...generateFrameworkColorUtilityClasses(colorFramework),
        hero: {
          id: 'hero',
          name: 'hero',
          kind: 'class',
          selector: '.hero',
          order: 0,
          styles: { fontSize: '48px' },
          contextStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
      },
      pages: [
        makePage({
          root: {
            moduleId: 'base.text',
            props: { text: 'Hi' },
            classIds: [textClassId, 'hero'],
          },
        }),
      ],
    })

    const bundle = buildSiteCssBundle(site, registry)

    expect(bundle.framework.content).toContain('--primary: hsla(238, 100%, 62%, 1);')
    expect(bundle.framework.content).toContain('.text-primary')
    expect(bundle.framework.content).toContain('color: var(--primary);')
    expect(bundle.framework.content).not.toContain('.bg-primary')
    expect(bundle.style.content).toContain('.hero')
    expect(bundle.style.content).not.toContain('.text-primary')
  })

  it('userStyles.css carries user-authored stylesheet files concatenated in path order', () => {
    const site = makeSite()
    const now = Date.now()
    site.files = [
      {
        id: 'b',
        path: 'src/styles/b-second.css',
        type: 'style',
        content: 'body > nav { background: black; }',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'a',
        path: 'src/styles/a-first.css',
        type: 'style',
        content: ':root { --brand: tomato; }',
        createdAt: now,
        updatedAt: now,
      },
      // Non-style files are ignored — proves the type filter works.
      {
        id: 'config',
        path: 'package.json',
        type: 'config',
        content: '{}',
        createdAt: now,
        updatedAt: now,
      },
    ]
    site.pages = [makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })]

    const bundle = buildSiteCssBundle(site, registry)

    // Sorted by path ascending: a-first.css before b-second.css.
    const firstIdx = bundle.userStyles.content.indexOf(':root { --brand: tomato; }')
    const secondIdx = bundle.userStyles.content.indexOf('body > nav { background: black; }')
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThan(firstIdx)
    // Non-style files are excluded entirely.
    expect(bundle.userStyles.content).not.toContain('package.json')
    // Each file is wrapped with a source-path comment so DevTools shows origin.
    expect(bundle.userStyles.content).toContain('/* src/styles/a-first.css */')
    expect(bundle.userStyles.content).toContain('/* src/styles/b-second.css */')
  })

  it('userStyles.css is empty when no user stylesheets exist', () => {
    const site = makeSite()
    site.pages = [makePage({ root: { moduleId: 'base.text', props: { text: 'X' } } })]
    const bundle = buildSiteCssBundle(site, registry)
    expect(bundle.userStyles.content).toBe('')
  })

  it('is deterministic: identical sites produce identical hashes', () => {
    const site1 = makeSite()
    const site2 = makeSite()
    site1.pages = [makePage({ root: { moduleId: 'base.text', props: { text: 'X' } } })]
    site2.pages = [makePage({ root: { moduleId: 'base.text', props: { text: 'X' } } })]

    const bundle1 = buildSiteCssBundle(site1, registry)
    const bundle2 = buildSiteCssBundle(site2, registry)

    expect(bundle1.reset.hash).toBe(bundle2.reset.hash)
    expect(bundle1.framework.hash).toBe(bundle2.framework.hash)
    expect(bundle1.style.hash).toBe(bundle2.style.hash)
    expect(bundle1.userStyles.hash).toBe(bundle2.userStyles.hash)
  })

  it('rotates the userStyles hash when user stylesheets change (the others stay)', () => {
    const baseSite = makeSite()
    baseSite.pages = [makePage({ root: { moduleId: 'base.text', props: { text: 'X' } } })]
    const before = buildSiteCssBundle(baseSite, registry)

    const editedSite = makeSite()
    editedSite.pages = baseSite.pages
    const now = Date.now()
    editedSite.files = [
      {
        id: 's1',
        path: 'src/styles/site.css',
        type: 'style',
        content: 'body { background: tomato; }',
        createdAt: now,
        updatedAt: now,
      },
    ]
    const after = buildSiteCssBundle(editedSite, registry)

    expect(after.reset.hash).toBe(before.reset.hash)
    expect(after.framework.hash).toBe(before.framework.hash)
    expect(after.style.hash).toBe(before.style.hash)
    expect(after.userStyles.hash).not.toBe(before.userStyles.hash)
  })

  it('rotates the style hash when user classes change (the others stay)', () => {
    const baseSite = makeSite()
    baseSite.pages = [makePage({ root: { moduleId: 'base.text', props: { text: 'X' } } })]
    const before = buildSiteCssBundle(baseSite, registry)

    const editedSite = makeSite()
    editedSite.pages = [
      makePage({
        root: {
          moduleId: 'base.text',
          props: { text: 'X' },
          classIds: ['hero'],
        },
      }),
    ]
    editedSite.styleRules = {
      hero: {
        id: 'hero',
        name: 'hero',
        kind: 'class',
        selector: '.hero',
        order: 0,
        styles: { color: '#ff0000' },
        contextStyles: {},
        createdAt: 0,
        updatedAt: 0,
      },
    }
    const after = buildSiteCssBundle(editedSite, registry)

    expect(after.reset.hash).toBe(before.reset.hash)
    expect(after.framework.hash).toBe(before.framework.hash)
    expect(after.style.hash).not.toBe(before.style.hash)
  })

  it('rotates the framework hash when generated framework utility output changes', () => {
    const textClassId = frameworkColorClassId('primary-token', 'base', 'text')
    const baseSite = makeSite({
      settings: {
        ...makeSite().settings,
        framework: { colors: colorFramework },
      },
      classes: generateFrameworkColorUtilityClasses(colorFramework),
      pages: [
        makePage({
          root: {
            moduleId: 'base.text',
            props: { text: 'X' },
            classIds: [textClassId],
          },
        }),
      ],
    })
    const before = buildSiteCssBundle(baseSite, registry)

    const editedSite = makeSite({
      settings: {
        ...makeSite().settings,
        framework: {
          colors: colorFramework,
          preferences: {
            rootFontSize: 10,
            minScreenWidth: 320,
            maxScreenWidth: 1400,
            isRem: true,
            treeShakeGeneratedFrameworkUtilities: false,
          },
        },
      },
      classes: generateFrameworkColorUtilityClasses(colorFramework),
      pages: baseSite.pages,
    })
    const after = buildSiteCssBundle(editedSite, registry)

    expect(after.reset.hash).toBe(before.reset.hash)
    expect(after.framework.hash).not.toBe(before.framework.hash)
    expect(after.style.hash).toBe(before.style.hash)
    expect(before.framework.content).not.toContain('.bg-primary')
    expect(after.framework.content).toContain('.bg-primary')
  })

  /**
   * Cascade layering. Unlayered CSS outranks every cascade layer regardless of
   * specificity or source order, so emitting the CMS baseline unlayered made it
   * silently override any imported stylesheet that uses `@layer` — i.e. every
   * Tailwind v4 build, whose whole output is layered. The imported CSS shipped
   * intact but inert, and the site rendered with CMS tokens instead.
   */
  describe('cascade layers', () => {
    it('declares the baseline layer order in reset, before either layer is used', () => {
      const { reset } = buildSiteCssBundle(makeSite(), registry)
      const order = reset.content.indexOf('@layer instatic-reset, instatic-framework;')
      expect(order).toBe(0)
      // The order statement must precede the block that populates the layer.
      expect(order).toBeLessThan(reset.content.indexOf('@layer instatic-reset {'))
    })

    it('wraps reset and framework in the baseline layers', () => {
      const site = makeSite()
      site.pages = [makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })]

      const { reset, framework } = buildSiteCssBundle(site, registry)
      expect(reset.content).toContain('@layer instatic-reset {')
      expect(framework.content).toContain('@layer instatic-framework {')
      // Module CSS travels inside the framework bundle, so it is layered too.
      expect(framework.content).toContain('h1 { color: black; }')
    })

    it('leaves author-authored class CSS unlayered so it still wins', () => {
      // `style` carries Styles-panel and imported class rules — explicit
      // authoring decisions that must outrank both the baseline and any
      // imported sheet. Unlayered is what buys that.
      const { style } = buildSiteCssBundle(makeSite(), registry)
      expect(style.content).not.toContain('@layer')
    })

    it('keeps user stylesheets unwrapped so their own @layer rules survive', () => {
      // A kept Tailwind sheet arrives already layered. Wrapping it again would
      // nest its layers under ours and re-invert the very precedence we fixed.
      const { userStyles } = buildSiteCssBundle(makeSite(), registry)
      expect(userStyles.content).not.toContain('@layer instatic-')
    })
  })
})
