/**
 * Unit tests for applyAssetRewrites — idempotent URL substitution.
 */

import { describe, it, expect } from 'bun:test'
// Self-registers all base modules with the global registry so importHtml works
import '@modules/base'
import { applyAssetRewrites, buildImportPlan } from '@core/siteImport'
import type { ImportPlan } from '@core/siteImport'
import { makeSampleFileMap, makeMockSiteDocument } from './mockSite'

describe('native video assets', () => {
  it('normalises and rewrites both the video source and poster to uploaded media', () => {
    const encoder = new TextEncoder()
    const html = '<html><body><video poster="../images/poster.jpg" preload="none"><source src="/media/intro.mp4"></video></body></html>'
    const plan = buildImportPlan({
      currentSite: makeMockSiteDocument(),
      fileMap: { files: {
        'pages/index.html': { bytes: encoder.encode(html) },
        'media/intro.mp4': { bytes: new Uint8Array([0, 0, 0, 0]), mimeType: 'video/mp4' },
        'images/poster.jpg': { bytes: new Uint8Array([255, 216, 255]), mimeType: 'image/jpeg' },
      } },
    })
    const video = Object.values(plan.pages[0]!.nodeFragment.nodes).find(node => node.moduleId === 'base.video')!
    expect(video.props).toMatchObject({ videoUrl: 'media/intro.mp4', poster: 'images/poster.jpg', preload: 'none' })
    expect(plan.assets.map(asset => asset.sourcePath).sort()).toEqual(['images/poster.jpg', 'media/intro.mp4'])
    const rewritten = applyAssetRewrites(plan, { 'media/intro.mp4': '/uploads/video.mp4', 'images/poster.jpg': '/uploads/poster.jpg' })
    expect(rewritten.pages[0]!.nodeFragment.nodes[video.id]!.props).toMatchObject({ videoUrl: '/uploads/video.mp4', poster: '/uploads/poster.jpg' })
    expect(video.props.videoUrl).toBe('media/intro.mp4')
    expect(applyAssetRewrites(rewritten, { 'media/intro.mp4': '/uploads/video.mp4' })).toEqual(rewritten)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ImportPlan for testing rewrites in isolation. */
function planWith(
  props: Record<string, unknown>,
  cssStyles: Record<string, unknown> = {},
): ImportPlan {
  return {
    pages: [
      {
        source: 'index.html',
        title: 'Home',
        slug: 'index',
        linkedCssPaths: [],
        scripts: [],
        nodeFragment: {
          rootIds: ['n1'],
          nodes: {
            n1: {
              id: 'n1',
              moduleId: 'base.image',
              props,
              breakpointOverrides: {},
              children: [],
              classIds: [],
            },
          },
        },
      },
    ],
    styleRules: cssStyles && Object.keys(cssStyles).length > 0
      ? [
          {
            name: 'body',
            kind: 'ambient',
            selector: 'body',
            order: 0,
            styles: cssStyles,
            contextStyles: {},
          },
        ]
      : [],
    styleRuleSources: cssStyles && Object.keys(cssStyles).length > 0 ? ['styles.css'] : [],
    fonts: [],
    googleFonts: [],
    conditions: [],
    assets: [],
    conflicts: { pages: [], rules: [], tokens: [] },
    warnings: [],
    colors: [],
    fontTokens: [],
    scripts: [],
    droppedAtRules: [],
    unusedCss: [],
  }
}

const REWRITE_MAP = { 'images/hero.png': '/media/abc123.png' }

// ---------------------------------------------------------------------------
// Node prop rewrites
// ---------------------------------------------------------------------------

describe('applyAssetRewrites — node props', () => {
  it('rewrites src prop that matches a FileMap key', () => {
    const plan = planWith({ src: 'images/hero.png', loading: 'lazy' })
    const result = applyAssetRewrites(plan, REWRITE_MAP)
    const node = Object.values(result.pages[0].nodeFragment.nodes)[0]
    expect(node.props['src']).toBe('/media/abc123.png')
    expect(node.props['loading']).toBe('lazy') // unchanged
  })

  it('leaves external src URL unchanged', () => {
    const plan = planWith({ src: 'https://cdn.example.com/img.png' })
    const result = applyAssetRewrites(plan, REWRITE_MAP)
    const node = Object.values(result.pages[0].nodeFragment.nodes)[0]
    expect(node.props['src']).toBe('https://cdn.example.com/img.png')
  })

  it('rewrites href prop', () => {
    const plan = planWith({ href: 'images/hero.png' })
    const result = applyAssetRewrites(plan, REWRITE_MAP)
    const node = Object.values(result.pages[0].nodeFragment.nodes)[0]
    expect(node.props['href']).toBe('/media/abc123.png')
  })

  it('rewrites srcset tokens', () => {
    const plan = planWith({ srcset: 'images/hero.png 1x, images/hero.png 2x' })
    const result = applyAssetRewrites(plan, REWRITE_MAP)
    const node = Object.values(result.pages[0].nodeFragment.nodes)[0]
    expect(node.props['srcset']).toBe('/media/abc123.png 1x, /media/abc123.png 2x')
  })

  it('rewrites HTML attributes that match FileMap keys', () => {
    const plan = planWith({
      htmlAttributes: {
        'data-bg-src': 'images/hero.png',
        'data-aos': 'fade-up',
      },
    })
    const result = applyAssetRewrites(plan, REWRITE_MAP)
    const node = Object.values(result.pages[0].nodeFragment.nodes)[0]
    expect(node.props['htmlAttributes']).toEqual({
      'data-bg-src': '/media/abc123.png',
      'data-aos': 'fade-up',
    })
  })

  it('is idempotent', () => {
    const plan = planWith({ src: 'images/hero.png' })
    const once = applyAssetRewrites(plan, REWRITE_MAP)
    const twice = applyAssetRewrites(once, REWRITE_MAP)
    // After the first pass, src is '/media/abc123.png' which is NOT a key
    // in REWRITE_MAP → second pass is a no-op.
    const node = Object.values(twice.pages[0].nodeFragment.nodes)[0]
    expect(node.props['src']).toBe('/media/abc123.png')
  })

  it('returns the same plan reference when rewriteMap is empty', () => {
    const plan = planWith({ src: 'images/hero.png' })
    const result = applyAssetRewrites(plan, {})
    expect(result).toBe(plan)
  })
})

// ---------------------------------------------------------------------------
// CSS style rewrites
// ---------------------------------------------------------------------------

describe('applyAssetRewrites — CSS styles', () => {
  it('rewrites url() in base styles', () => {
    const plan = planWith({}, { backgroundImage: `url('images/hero.png')` })
    const result = applyAssetRewrites(plan, REWRITE_MAP)
    const rule = result.styleRules[0]
    expect((rule.styles as Record<string, string>)['backgroundImage']).toBe(
      `url('/media/abc123.png')`,
    )
  })

  it('rewrites url() with double quotes', () => {
    const plan = planWith({}, { backgroundImage: `url("images/hero.png")` })
    const result = applyAssetRewrites(plan, REWRITE_MAP)
    const rule = result.styleRules[0]
    expect((rule.styles as Record<string, string>)['backgroundImage']).toBe(
      `url('/media/abc123.png')`,
    )
  })

  it('rewrites url() in contextStyles', () => {
    const basePlan: ImportPlan = {
      pages: [],
      styleRules: [
        {
          name: 'body',
          kind: 'ambient',
          selector: 'body',
          order: 0,
          styles: {},
          contextStyles: {
            mobile: { backgroundImage: `url('images/hero.png')` },
          },
        },
      ],
      styleRuleSources: ['styles.css'],
      fonts: [],
      googleFonts: [],
      conditions: [],
      assets: [],
      conflicts: { pages: [], rules: [], tokens: [] },
      warnings: [],
      colors: [],
      fontTokens: [],
      scripts: [],
      droppedAtRules: [],
      unusedCss: [],
    }
    const result = applyAssetRewrites(basePlan, REWRITE_MAP)
    const mobileStyle = result.styleRules[0].contextStyles['mobile'] as Record<string, string>
    expect(mobileStyle['backgroundImage']).toBe(`url('/media/abc123.png')`)
  })

  it('handles multiple url() in a single value', () => {
    const plan = planWith(
      {},
      { background: `url('images/hero.png') center, url('images/hero.png') top` },
    )
    const result = applyAssetRewrites(plan, REWRITE_MAP)
    const rule = result.styleRules[0]
    const bg = (rule.styles as Record<string, string>)['background']
    // Both occurrences should be rewritten
    expect(bg).not.toContain('images/hero.png')
    expect(bg).toContain('/media/abc123.png')
  })

  it('rewrites url() in raw keyframes CSS', () => {
    const basePlan: ImportPlan = {
      pages: [],
      styleRules: [
        {
          name: '@keyframes mask',
          kind: 'ambient',
          selector: '@keyframes mask',
          order: 0,
          styles: {},
          contextStyles: {},
          rawCss: "@keyframes mask {\n  100% {\n    mask-image: url('images/hero.png');\n  }\n}",
        },
      ],
      styleRuleSources: ['styles.css'],
      fonts: [],
      googleFonts: [],
      conditions: [],
      assets: [],
      conflicts: { pages: [], rules: [], tokens: [] },
      warnings: [],
      colors: [],
      fontTokens: [],
      scripts: [],
      droppedAtRules: [],
      unusedCss: [],
    }
    const result = applyAssetRewrites(basePlan, REWRITE_MAP)
    expect(result.styleRules[0].rawCss).toContain("url('/media/abc123.png')")
    expect(result.styleRules[0].rawCss).not.toContain('images/hero.png')
  })
})

// ---------------------------------------------------------------------------
// Inline background (node.inlineStyles) rewrites
// ---------------------------------------------------------------------------

describe('applyAssetRewrites — inline background node.inlineStyles', () => {
  it('rewrites a normalised url() on node.inlineStyles to the media URL', () => {
    const plan: ImportPlan = {
      pages: [
        {
          source: 'index.html',
          title: 'Home',
          slug: 'index',
          linkedCssPaths: [],
          scripts: [],
          nodeFragment: {
            rootIds: ['n1'],
            nodes: {
              n1: {
                id: 'n1',
                moduleId: 'base.container',
                props: {},
                breakpointOverrides: {},
                children: [],
                classIds: [],
                inlineStyles: { backgroundImage: `url('images/hero.png')` },
              },
            },
          },
        },
      ],
      styleRules: [],
      styleRuleSources: [],
      fonts: [],
      googleFonts: [],
      conditions: [],
      assets: [],
      conflicts: { pages: [], rules: [], tokens: [] },
      warnings: [],
      colors: [],
      fontTokens: [],
      scripts: [],
      droppedAtRules: [],
      unusedCss: [],
    }
    const result = applyAssetRewrites(plan, REWRITE_MAP)
    const bag = result.pages[0].nodeFragment.nodes['n1']!.inlineStyles!
    expect(bag.backgroundImage).toBe(`url('/media/abc123.png')`)
  })
})

// ---------------------------------------------------------------------------
// End-to-end rewrite via buildImportPlan
// ---------------------------------------------------------------------------

describe('applyAssetRewrites — end-to-end via buildImportPlan', () => {
  it('no source paths remain after rewriting', () => {
    const fileMap = makeSampleFileMap()
    const currentSite = makeMockSiteDocument()
    const plan = buildImportPlan({ fileMap, currentSite })

    // After uploading, every asset's sourcePath maps to a fake new URL
    const rewriteMap: Record<string, string> = {}
    for (const asset of plan.assets) {
      rewriteMap[asset.sourcePath] = `/media/${asset.sourcePath.replace(/[^a-z0-9.]/g, '_')}`
    }
    const rewritten = applyAssetRewrites(plan, rewriteMap)

    // Collect all string prop values across all nodes in all pages
    for (const page of rewritten.pages) {
      for (const node of Object.values(page.nodeFragment.nodes)) {
        for (const [key, val] of Object.entries(node.props)) {
          if (typeof val !== 'string') continue
          // No value should still match an original sourcePath
          for (const src of Object.keys(rewriteMap)) {
            if (val === src) {
              throw new Error(
                `Node prop ${key} still contains source path "${src}" after rewrite`,
              )
            }
          }
        }
      }
    }

    // Collect all CSS style values
    for (const rule of rewritten.styleRules) {
      const allBags = [
        rule.styles as Record<string, string>,
        ...Object.values(rule.contextStyles) as Record<string, string>[],
      ]
      for (const bag of allBags) {
        for (const [, val] of Object.entries(bag)) {
          if (typeof val !== 'string') continue
          for (const src of Object.keys(rewriteMap)) {
            if (val.includes(`url('${src}')`)) {
              throw new Error(`CSS value still contains source path "${src}" after rewrite`)
            }
          }
        }
      }
    }
  })
})
