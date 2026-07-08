import { describe, expect, it } from 'bun:test'
import {
  createCanvasClassCssMemo,
  generateCanvasClassCSS,
  generateForcedStateCSS,
} from '@site/canvas/canvasClassCss'
import { generateFrameworkColorUtilityClasses } from '@core/framework'
import { classKindSelector, type StyleRule } from '@core/page-tree'
import type { RenderResolvedMedia } from '@core/publisher'

function makeClass(
  id: string,
  styles: StyleRule['styles'],
  contextStyles: StyleRule['contextStyles'] = {},
): StyleRule {
  return {
    id,
    name: id,
    kind: 'class',
    selector: classKindSelector(id),
    order: 0,
    styles,
    contextStyles,
    createdAt: 0,
    updatedAt: 0,
  }
}

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

describe('generateCanvasClassCSS', () => {
  it('prepends the unscoped publisher reset so the iframe cascade matches the published page', () => {
    const css = generateCanvasClassCSS({}, [])

    // Each canvas breakpoint frame is its own iframe — the reset lives inside
    // the iframe document and never touches editor chrome. We emit the
    // SAME unscoped reset the publisher ships, so the cascade is identical
    // between canvas preview and live site.
    expect(css).toContain(':where(*, *::before, *::after) { box-sizing: border-box; }')
    expect(css).toContain(':where(*) { margin: 0; padding: 0; }')
    expect(css).toContain('font-family: system-ui')
    // No `[data-breakpoint-id]` prefix on the reset itself — it's unscoped.
    expect(css).not.toMatch(/\[data-breakpoint-id\][^{]*\{[^}]*box-sizing/)
  })

  it('uses :where()-style low-specificity body baseline so user CSS wins', () => {
    // The published `<body>` rule is `:where(body) { line-height; font-family }`
    // — specificity 0,0,0 so any user rule like `body { color: red }` wins.
    // The canvas now mirrors that exactly (was previously a concrete
    // `[data-breakpoint-id] { color: #000 }` rule which beat user CSS at
    // specificity 0,1,0; not needed anymore because the iframe has its own
    // body and the editor's globals.css can't cascade in).
    const css = generateCanvasClassCSS({}, [])
    expect(css).toContain(':where(body)')
    // Body color isn't pinned — UA default applies until user CSS overrides.
    expect(css).not.toMatch(/\[data-breakpoint-id\][^{]*\{[^}]*color:\s*#000/)
  })

  it('uses the viewport context media query for canvas breakpoint styles', () => {
    const css = generateCanvasClassCSS(
      {
        title: makeClass('title', { fontSize: '64px' }, {
          mobile: { fontSize: '36px' },
        }),
      },
      [{ id: 'mobile', width: 375, mediaQuery: '(min-width: 375px)' }],
    )

    expect(css).toContain('.title')
    expect(css).toContain('font-size: 64px')
    expect(css).toContain('@media (min-width: 375px)')
    expect(css).toContain('font-size: 36px')
    expect(css).not.toContain('[data-breakpoint-id="mobile"] .title')
  })

  it('rewrites class background images to optimized image-set candidates in the canvas CSS', () => {
    const css = generateCanvasClassCSS(
      {
        hero: makeClass('hero', { backgroundImage: "url('/uploads/hero.png')" }),
      },
      [],
      [],
      null,
      null,
      null,
      null,
      null,
      {
        mediaAssets: new Map([['/uploads/hero.png', resolvedMedia()]]),
        mediaSignature: 'hero',
      },
    )

    expect(css).toContain('background-image: url("/uploads/hero-w2048.webp");')
    expect(css).toContain('background-image: image-set(')
    expect(css).toContain('url("/uploads/hero-w1024.webp") 1x')
    expect(css).not.toContain('/uploads/hero.png')
  })

  it('emits sanitized raw @keyframes rules, matching the published output', () => {
    // Regression: the canvas used to skip `rawCss` rules entirely, so
    // imported keyframe animations published fine but never played in the
    // editor preview. The canvas now routes through the publisher's
    // `generateClassCSS`, which emits them through the same safety gate.
    const pulse: StyleRule = {
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
    }

    const css = generateCanvasClassCSS({ pulse }, [])
    expect(css).toContain('@keyframes pulse')
    expect(css).toContain('opacity: 0')
  })

  it('drops unsupported raw CSS, matching the published output', () => {
    const bad: StyleRule = {
      id: 'bad',
      name: 'bad',
      kind: 'ambient',
      selector: '.bad',
      order: 0,
      styles: {},
      contextStyles: {},
      rawCss: '@media screen { .bad { color: red; } }',
      createdAt: 0,
      updatedAt: 0,
    }

    expect(generateCanvasClassCSS({ bad }, [])).not.toContain('.bad')
  })

  it('includes framework color variables for editor preview', () => {
    const colors = {
      tokens: [
        {
          id: 'primary-token',
          category: '',
          slug: 'primary',
          lightValue: 'hsla(238, 100%, 62%, 1)',
          darkValue: 'hsla(238, 100%, 42%, 1)',
          darkModeEnabled: true,
          generateUtilities: {
            text: true,
            background: false,
            border: false,
            fill: false,
          },
          generateTransparent: false,
          generateShades: { enabled: false, count: 0 },
          generateTints: { enabled: false, count: 0 },
          order: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }

    const css = generateCanvasClassCSS(
      generateFrameworkColorUtilityClasses(colors),
      [],
      [],
      colors,
    )

    expect(css).toContain(':root.theme-alt')
    expect(css).not.toContain('theme-dark')
    expect(css).toContain('--primary: hsla(238, 100%, 62%, 1);')
    expect(css).toContain('.text-primary')
    expect(css).toContain('color: var(--primary);')
  })
})

describe('createCanvasClassCssMemo', () => {
  const classes = { title: makeClass('title', { fontSize: '64px' }) }
  const breakpoints = [{ id: 'mobile', width: 375, mediaQuery: '(min-width: 375px)' }]
  const conditions: never[] = []

  function countingMemo() {
    let calls = 0
    const memo = createCanvasClassCssMemo((...args) => {
      calls++
      return `generated-${calls}-${Object.keys(args[0]).length}`
    })
    return { memo, calls: () => calls }
  }

  it('generates once per identity-equal input set — frames 2..N hit the cache', () => {
    const { memo, calls } = countingMemo()

    // 3 breakpoint-frame injectors re-running with the SAME store snapshot.
    const first = memo(classes, breakpoints, conditions, null, null, null, null, null)
    const second = memo(classes, breakpoints, conditions, null, null, null, null, null)
    const third = memo(classes, breakpoints, conditions, null, null, null, null, null)

    expect(calls()).toBe(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('regenerates when any input identity changes', () => {
    const { memo, calls } = countingMemo()
    memo(classes, breakpoints, conditions, null, null, null, null, null)

    // Same content, new identity — a store commit always mints new refs.
    memo({ ...classes }, breakpoints, conditions, null, null, null, null, null)
    expect(calls()).toBe(2)

    memo({ ...classes }, [...breakpoints], conditions, null, null, null, null, null)
    expect(calls()).toBe(3)
  })

  it('regenerates when the responsive background media signature changes', () => {
    const { memo, calls } = countingMemo()
    const mediaAssets = new Map([['/uploads/hero.png', resolvedMedia()]])

    memo(classes, breakpoints, conditions, null, null, null, null, null, {
      mediaAssets,
      mediaSignature: 'a',
    })
    memo(classes, breakpoints, conditions, null, null, null, null, null, {
      mediaAssets,
      mediaSignature: 'a',
    })
    expect(calls()).toBe(1)

    memo(classes, breakpoints, conditions, null, null, null, null, null, {
      mediaAssets,
      mediaSignature: 'b',
    })
    expect(calls()).toBe(2)
  })

  it('the exported generator produces identical CSS for cached and fresh inputs', () => {
    const cached = generateCanvasClassCSS(classes, breakpoints)
    expect(generateCanvasClassCSS(classes, breakpoints)).toBe(cached)
    // Fresh identities regenerate, but the output text is byte-identical.
    expect(generateCanvasClassCSS({ ...classes }, [...breakpoints])).toBe(cached)
  })
})

describe('generateForcedStateCSS', () => {
  const hoverRule = (
    styles: StyleRule['styles'],
    contextStyles: StyleRule['contextStyles'] = {},
  ): StyleRule => ({
    id: 'hover',
    name: '.btn:hover',
    kind: 'ambient',
    selector: '.btn:hover',
    order: 0,
    styles,
    contextStyles,
    createdAt: 0,
    updatedAt: 0,
  })

  it('paints base declarations onto the node with a doubled attribute selector', () => {
    const css = generateForcedStateCSS('node-1', hoverRule({ color: 'red', fontWeight: '700' }), [])
    expect(css).toContain('[data-node-id="node-1"][data-node-id="node-1"]')
    expect(css).toContain('color: red')
    expect(css).toContain('font-weight: 700')
  })

  it('emits per-breakpoint overrides under the breakpoint media query, node-scoped', () => {
    const css = generateForcedStateCSS(
      'node-1',
      hoverRule({ color: 'red' }, { mobile: { color: 'blue' } }),
      [{ id: 'mobile', width: 375, mediaQuery: '(min-width: 375px)' }],
    )
    // Base hover preview.
    expect(css).toContain('color: red')
    // Breakpoint override wrapped in the real media query, still node-scoped — so
    // only the matching-width frame previews it, like the published page.
    expect(css).toContain('@media (min-width: 375px)')
    expect(css).toContain('color: blue')
    expect(css).toMatch(/@media[^{]*\{\s*\[data-node-id="node-1"\]\[data-node-id="node-1"\]/)
  })

  it('overlays an in-flight edit into the context it targets', () => {
    const css = generateForcedStateCSS(
      'node-1',
      hoverRule({ color: 'red' }, { mobile: { color: 'blue' } }),
      [{ id: 'mobile', width: 375, mediaQuery: '(min-width: 375px)' }],
      [],
      { contextId: 'mobile', styles: { color: 'green' } },
    )
    // Base unchanged; the mobile override reflects the in-flight green.
    expect(css).toContain('color: red')
    expect(css).toContain('color: green')
    expect(css).not.toContain('color: blue')
  })

  it('returns an empty string when there are no declarations', () => {
    expect(generateForcedStateCSS('node-1', hoverRule({}), [])).toBe('')
  })

  it('escapes quotes in the node id', () => {
    const css = generateForcedStateCSS('a"b', hoverRule({ color: 'red' }), [])
    expect(css).toContain('[data-node-id="a\\"b"]')
  })
})
