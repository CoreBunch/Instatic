/**
 * Unit tests for assetPlan — asset collection and URL normalisation.
 */

import { describe, it, expect } from 'bun:test'
// Self-registers all base modules with the global registry so importHtml works
import '@modules/base'
import { buildAssetPlan, makeHtmlPagePlan, cssToStyleRules } from '@core/siteImport'
import type { FileMap, CssFileResult } from '@core/siteImport'
import { MINIMAL_PNG } from './fixtures'

const enc = new TextEncoder()
const txt = (s: string) => enc.encode(s)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFileMap(entries: Record<string, { bytes?: Uint8Array; mimeType?: string }>): FileMap {
  const files: FileMap['files'] = {}
  for (const [path, entry] of Object.entries(entries)) {
    files[path] = { bytes: entry.bytes ?? txt(''), mimeType: entry.mimeType }
  }
  return { files }
}

// ---------------------------------------------------------------------------
// img src normalisation
// ---------------------------------------------------------------------------

describe('buildAssetPlan — img src normalisation', () => {
  it('normalises relative img src to FileMap key', () => {
    const fileMap = makeFileMap({
      'index.html': { bytes: txt('<html><body><img src="images/hero.png"></body></html>') },
      'images/hero.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
    })
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    const { normalizedPagePlans, assets } = buildAssetPlan([pagePlan], [], fileMap)

    // Find the image node
    const nodes = Object.values(normalizedPagePlans[0].nodeFragment.nodes)
    const imageNode = nodes.find((n) => typeof n.props['src'] === 'string' && (n.props['src'] as string).startsWith('images/'))
    expect(imageNode?.props['src']).toBe('images/hero.png')
    // Asset should be recorded
    expect(assets.some((a) => a.sourcePath === 'images/hero.png')).toBe(true)
  })

  it('leaves external URLs unchanged', () => {
    const fileMap = makeFileMap({
      'index.html': { bytes: txt('<html><body><img src="https://cdn.example.com/img.png"></body></html>') },
    })
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    const { normalizedPagePlans, assets } = buildAssetPlan([pagePlan], [], fileMap)

    const nodes = Object.values(normalizedPagePlans[0].nodeFragment.nodes)
    const imageNode = nodes.find((n) => typeof n.props['src'] === 'string')
    expect(imageNode?.props['src']).toBe('https://cdn.example.com/img.png')
    expect(assets).toHaveLength(0)
  })

  it('does not record an asset if the file is not in the FileMap', () => {
    const fileMap = makeFileMap({
      'index.html': { bytes: txt('<html><body><img src="missing.png"></body></html>') },
    })
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    const { assets } = buildAssetPlan([pagePlan], [], fileMap)
    expect(assets).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// HTML attribute asset normalisation
// ---------------------------------------------------------------------------

describe('buildAssetPlan — HTML attribute asset normalisation', () => {
  it('normalises data-bg-src to a FileMap key and records the asset', () => {
    const fileMap = makeFileMap({
      'pricing.html': {
        bytes: txt('<html><body><section data-bg-src="assets/images/shape/heroShape1_1.png">Pricing</section></body></html>'),
      },
      'assets/images/shape/heroShape1_1.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
    })
    const { pagePlan } = makeHtmlPagePlan('pricing.html', new TextDecoder().decode(fileMap.files['pricing.html']!.bytes), fileMap)
    const { normalizedPagePlans, assets } = buildAssetPlan([pagePlan], [], fileMap)

    const node = normalizedPagePlans[0].nodeFragment.nodes[normalizedPagePlans[0].nodeFragment.rootIds[0]!]!
    expect(node.props['htmlAttributes']).toEqual({
      'data-bg-src': 'assets/images/shape/heroShape1_1.png',
    })
    expect(assets.some((a) => a.sourcePath === 'assets/images/shape/heroShape1_1.png')).toBe(true)
  })

  it('leaves external data-* URLs unchanged and records no asset', () => {
    const fileMap = makeFileMap({
      'index.html': {
        bytes: txt('<html><body><section data-bg-src="https://cdn.example.com/bg.png">Hero</section></body></html>'),
      },
    })
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    const { normalizedPagePlans, assets } = buildAssetPlan([pagePlan], [], fileMap)

    const node = normalizedPagePlans[0].nodeFragment.nodes[normalizedPagePlans[0].nodeFragment.rootIds[0]!]!
    expect(node.props['htmlAttributes']).toEqual({ 'data-bg-src': 'https://cdn.example.com/bg.png' })
    expect(assets).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Inline background-image (node.inlineStyles) normalisation
// ---------------------------------------------------------------------------

function inlineBgNode(plan: { nodeFragment: { nodes: Record<string, { inlineStyles?: Record<string, unknown> }> } }) {
  return Object.values(plan.nodeFragment.nodes).find((n) => n.inlineStyles)
}

describe('buildAssetPlan — inline background node.inlineStyles normalisation', () => {
  it('normalises an inline background url() to a FileMap key and records the asset', () => {
    const fileMap = makeFileMap({
      'index.html': {
        bytes: txt(`<html><body><section style="background-image: url('images/hero.png')">x</section></body></html>`),
      },
      'images/hero.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
    })
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    // Sanity: the importer captured the inline background on a node.
    expect(inlineBgNode(pagePlan)).toBeDefined()

    const { normalizedPagePlans, assets } = buildAssetPlan([pagePlan], [], fileMap)
    const bag = inlineBgNode(normalizedPagePlans[0])!.inlineStyles!
    expect(bag.backgroundImage).toContain(`url('images/hero.png')`)
    expect(assets.some((a) => a.sourcePath === 'images/hero.png')).toBe(true)
  })

  it('leaves an external inline background url() unchanged and records no asset', () => {
    const fileMap = makeFileMap({
      'index.html': {
        bytes: txt(`<html><body><section style="background-image: url('https://cdn.example.com/bg.png')">x</section></body></html>`),
      },
    })
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    const { normalizedPagePlans, assets } = buildAssetPlan([pagePlan], [], fileMap)
    const bag = inlineBgNode(normalizedPagePlans[0])!.inlineStyles!
    expect(bag.backgroundImage).toContain('https://cdn.example.com/bg.png')
    expect(assets).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// CSS url() normalisation
// ---------------------------------------------------------------------------

describe('buildAssetPlan — CSS url() normalisation', () => {
  it('normalises url() reference to FileMap key', () => {
    const css = `body { background-image: url('../images/bg.png') }`
    const fileMap = makeFileMap({
      'styles/main.css': { bytes: txt(css), mimeType: 'text/css' },
      'images/bg.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
    })
    const { rules, assetRefs } = cssToStyleRules(css)
    const cssFileResults: CssFileResult[] = [{ cssPath: 'styles/main.css', rules, assetRefs }]
    const { normalizedStyleRules, assets } = buildAssetPlan([], cssFileResults, fileMap)

    // The url() should reference the FileMap key
    const bodyRule = normalizedStyleRules.find((r) => r.selector === 'body')
    expect(bodyRule).toBeDefined()
    const bgValue = (bodyRule!.styles as Record<string, string>)['backgroundImage']
    expect(bgValue).toContain(`url('images/bg.png')`)

    // Asset recorded
    expect(assets.some((a) => a.sourcePath === 'images/bg.png')).toBe(true)
  })

  it('normalises a url() inside a custom-condition context (@media) and records the asset', () => {
    // Regression: background-image inside an @media block lives in a
    // per-context override bag, whose url() must be rewritten (else the asset
    // uploads but the context keeps the source path → broken link).
    const css = `@media (max-width: 600px) { .hero { background-image: url('img/bg.png') } }`
    const fileMap = makeFileMap({
      'styles.css': { bytes: txt(css), mimeType: 'text/css' },
      'img/bg.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
    })
    const { rules, assetRefs } = cssToStyleRules(css)
    const { normalizedStyleRules, assets } = buildAssetPlan(
      [], [{ cssPath: 'styles.css', rules, assetRefs }], fileMap,
    )
    const hero = normalizedStyleRules.find((r) => r.selector === '.hero')!
    const bag = Object.values(hero.contextStyles)[0] as Record<string, string>
    expect(bag['backgroundImage']).toContain(`url('img/bg.png')`)  // normalised to FileMap key
    expect(assets.some((a) => a.sourcePath === 'img/bg.png')).toBe(true) // uploaded
  })

  it('deduplicates assets referenced in multiple places', () => {
    const css = `.a { background: url('images/hero.png') }
.b { background: url('images/hero.png') }`
    const fileMap = makeFileMap({
      'styles.css': { bytes: txt(css) },
      'images/hero.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
    })
    const { rules, assetRefs } = cssToStyleRules(css)
    const { assets } = buildAssetPlan([], [{ cssPath: 'styles.css', rules, assetRefs }], fileMap)
    const heroAssets = assets.filter((a) => a.sourcePath === 'images/hero.png')
    expect(heroAssets).toHaveLength(1)
  })

  it('normalises url() in a breakpoint context bag', () => {
    const css = `@media (max-width: 768px) { body { background-image: url('images/hero.png') } }`
    const fileMap = makeFileMap({
      'main.css': { bytes: txt(css) },
      'images/hero.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
    })
    const breakpoints = [{ id: 'mobile', width: 768 }]
    const { rules, assetRefs } = cssToStyleRules(css, { breakpoints })
    const { normalizedStyleRules, assets } = buildAssetPlan(
      [],
      [{ cssPath: 'main.css', rules, assetRefs }],
      fileMap,
    )
    const bodyRule = normalizedStyleRules.find((r) => r.selector === 'body')
    const mobileBg = (bodyRule?.contextStyles['mobile'] as Record<string, string> | undefined)?.[
      'backgroundImage'
    ]
    expect(mobileBg).toContain(`url('images/hero.png')`)
    expect(assets.some((a) => a.sourcePath === 'images/hero.png')).toBe(true)
  })

  it('normalises url() inside raw keyframes CSS and records the asset', () => {
    const css = `@keyframes reveal { 100% { mask-image: url('../images/mask.png') } }`
    const fileMap = makeFileMap({
      'styles/main.css': { bytes: txt(css), mimeType: 'text/css' },
      'images/mask.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
    })
    const { rules, assetRefs } = cssToStyleRules(css)
    const { normalizedStyleRules, assets } = buildAssetPlan(
      [],
      [{ cssPath: 'styles/main.css', rules, assetRefs }],
      fileMap,
    )
    expect(normalizedStyleRules[0].rawCss).toContain(`url('images/mask.png')`)
    expect(assets.some((a) => a.sourcePath === 'images/mask.png')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Asset MIME type
// ---------------------------------------------------------------------------

describe('buildAssetPlan — MIME types', () => {
  it('uses entry.mimeType from FileMap when present', () => {
    const fileMap = makeFileMap({
      'index.html': { bytes: txt('<html><body><img src="logo.svg"></body></html>') },
      'logo.svg': { bytes: txt('<svg/>'), mimeType: 'image/svg+xml' },
    })
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    const { assets } = buildAssetPlan([pagePlan], [], fileMap)
    expect(assets[0]?.mimeType).toBe('image/svg+xml')
  })

  it('guesses MIME type from extension when not provided', () => {
    const fileMap = makeFileMap({
      'index.html': { bytes: txt('<html><body><img src="logo.png"></body></html>') },
      'logo.png': { bytes: MINIMAL_PNG },
    })
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    const { assets } = buildAssetPlan([pagePlan], [], fileMap)
    expect(assets[0]?.mimeType).toBe('image/png')
  })

  it('sweeps unreferenced uploadable assets but skips source companion files', () => {
    const fileMap = makeFileMap({
      'index.html': { bytes: txt('<html><body><h1>Home</h1></body></html>'), mimeType: 'text/html' },
      'assets/hero.avif': { bytes: txt('avif') },
      'assets/logo.png': { bytes: MINIMAL_PNG },
      'assets/brand.woff2': { bytes: txt('font') },
      'assets/reel.mp4': { bytes: txt('video') },
      'scss/main.scss': { bytes: txt('$brand: red;') },
      'assets/css/main.css.map': { bytes: txt('{}') },
      'README.md': { bytes: txt('# docs') },
      'mail.php': { bytes: txt('<?php') },
      'desktop.ini': { bytes: txt('[LocalizedFileNames]') },
    })
    const { pagePlan } = makeHtmlPagePlan(
      'index.html',
      new TextDecoder().decode(fileMap.files['index.html']!.bytes),
      fileMap,
    )
    const { assets } = buildAssetPlan([pagePlan], [], fileMap)

    expect(assets.map((a) => a.sourcePath).sort()).toEqual([
      'assets/brand.woff2',
      'assets/hero.avif',
      'assets/logo.png',
      'assets/reel.mp4',
    ])
    expect(assets.map((a) => a.mimeType).sort()).toEqual([
      'font/woff2',
      'image/avif',
      'image/png',
      'video/mp4',
    ])
  })
})

// ---------------------------------------------------------------------------
// HTML / CSS files must never appear in the asset list (regression guard)
// ---------------------------------------------------------------------------

describe('buildAssetPlan — anchor hrefs to HTML pages do not produce assets', () => {
  it('does not add an HTML page to assets when an anchor links to it', () => {
    // index.html has <a href="about.html"> — about.html must NOT be treated as
    // an uploadable media asset, even though it exists in the FileMap.
    const fileMap = makeFileMap({
      'index.html': {
        bytes: txt('<html><body><a href="about.html">About</a></body></html>'),
        mimeType: 'text/html',
      },
      'about.html': {
        bytes: txt('<html><body><h1>About</h1></body></html>'),
        mimeType: 'text/html',
      },
    })
    const src = new TextDecoder().decode(fileMap.files['index.html']!.bytes)
    const { pagePlan } = makeHtmlPagePlan('index.html', src, fileMap)
    const { assets } = buildAssetPlan([pagePlan], [], fileMap)

    expect(assets.every((a) => a.sourcePath !== 'about.html')).toBe(true)
    expect(assets).toHaveLength(0)
  })

  it('does not add a CSS file to assets when a node href points to one', () => {
    const fileMap = makeFileMap({
      'index.html': {
        bytes: txt('<html><body><a href="styles/main.css">Download styles</a></body></html>'),
        mimeType: 'text/html',
      },
      'styles/main.css': { bytes: txt('.x{color:red}'), mimeType: 'text/css' },
    })
    const src = new TextDecoder().decode(fileMap.files['index.html']!.bytes)
    const { pagePlan } = makeHtmlPagePlan('index.html', src, fileMap)
    const { assets } = buildAssetPlan([pagePlan], [], fileMap)

    expect(assets.every((a) => a.sourcePath !== 'styles/main.css')).toBe(true)
    expect(assets).toHaveLength(0)
  })

  it('still records image assets referenced via img src alongside HTML anchor links', () => {
    // Page has both a navigation anchor AND an image — only the image is an asset.
    const fileMap = makeFileMap({
      'index.html': {
        bytes: txt('<html><body><a href="about.html">About</a><img src="logo.png"></body></html>'),
        mimeType: 'text/html',
      },
      'about.html': { bytes: txt('<html><body></body></html>'), mimeType: 'text/html' },
      'logo.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
    })
    const src = new TextDecoder().decode(fileMap.files['index.html']!.bytes)
    const { pagePlan } = makeHtmlPagePlan('index.html', src, fileMap)
    const { assets } = buildAssetPlan([pagePlan], [], fileMap)

    expect(assets).toHaveLength(1)
    expect(assets[0]?.sourcePath).toBe('logo.png')
    expect(assets[0]?.mimeType).toBe('image/png')
    expect(assets.every((a) => a.sourcePath !== 'about.html')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Unresolved references
// ---------------------------------------------------------------------------

describe('buildAssetPlan — references the archive cannot satisfy', () => {
  it('matches a file whose stored name differs only in punctuation', () => {
    // Real Webflow export: the file keeps `&`, `+`, and a space; the HTML
    // written against it does not. Without the fallback the page imports with
    // a broken image and nothing says why.
    const stored = 'images/101-&Berlin-Office-Us+ Coworking.webp'
    const referenced = 'images/101-Berlin-Office-Us-Coworking.webp'
    const fileMap = makeFileMap({
      'index.html': { bytes: txt(`<html><body><img src="${referenced}"></body></html>`), mimeType: 'text/html' },
      [stored]: { bytes: MINIMAL_PNG, mimeType: 'image/webp' },
    })
    const src = new TextDecoder().decode(fileMap.files['index.html']!.bytes)
    const { pagePlan } = makeHtmlPagePlan('index.html', src, fileMap)
    const { normalizedPagePlans, assets, warnings } = buildAssetPlan([pagePlan], [], fileMap)

    const nodes = Object.values(normalizedPagePlans[0].nodeFragment.nodes)
    const imageNode = nodes.find((n) => typeof n.props['src'] === 'string')
    expect(imageNode?.props['src']).toBe(stored)
    expect(assets.map((a) => a.sourcePath)).toEqual([stored])
    expect(warnings).toHaveLength(0)
  })

  it('refuses to guess when two files differ only in punctuation', () => {
    // Picking one would silently put the wrong image on the page.
    const fileMap = makeFileMap({
      'index.html': { bytes: txt('<html><body><img src="images/a-b.png"></body></html>'), mimeType: 'text/html' },
      'images/a&b.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
      'images/a+b.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
    })
    const src = new TextDecoder().decode(fileMap.files['index.html']!.bytes)
    const { pagePlan } = makeHtmlPagePlan('index.html', src, fileMap)
    const { normalizedPagePlans, warnings } = buildAssetPlan([pagePlan], [], fileMap)

    const nodes = Object.values(normalizedPagePlans[0].nodeFragment.nodes)
    const imageNode = nodes.find((n) => typeof n.props['src'] === 'string')
    expect(imageNode?.props['src']).toBe('images/a-b.png')
    expect(warnings.map((w) => w.kind)).toEqual(['unresolved-asset'])
  })

  it('warns once per missing image, however many pages reference it', () => {
    const html = '<html><body><img src="images/gone.png"></body></html>'
    const fileMap = makeFileMap({
      'index.html': { bytes: txt(html), mimeType: 'text/html' },
      'about.html': { bytes: txt(html), mimeType: 'text/html' },
    })
    const plans = ['index.html', 'about.html'].map(
      (path) => makeHtmlPagePlan(path, new TextDecoder().decode(fileMap.files[path]!.bytes), fileMap).pagePlan,
    )
    const { warnings } = buildAssetPlan(plans, [], fileMap)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.kind).toBe('unresolved-asset')
    expect(warnings[0]?.path).toBe('images/gone.png')
    expect(warnings[0]?.message).toContain('images/gone.png')
  })

  it('reports a missing CSS background image too', () => {
    const css = '.hero{background-image:url("../images/missing.jpg")}'
    const fileMap = makeFileMap({
      'styles/site.css': { bytes: txt(css), mimeType: 'text/css' },
    })
    const parsed = cssToStyleRules(css)
    const cssFileResults: CssFileResult[] = [
      { cssPath: 'styles/site.css', rules: parsed.rules, assetRefs: parsed.assetRefs },
    ]
    const { warnings } = buildAssetPlan([], cssFileResults, fileMap)

    expect(warnings.map((w) => w.path)).toEqual(['images/missing.jpg'])
  })

  it('stays quiet about links, routes, and scripts that are not in the archive', () => {
    // An anchor to an extensionless route, a page that lives elsewhere, and a
    // CDN script are all normal. Warning about them would bury the real
    // missing images.
    const fileMap = makeFileMap({
      'index.html': {
        bytes: txt(
          '<html><body><a href="/contact">Contact</a><a href="missing-page.html">Gone</a><img src="logo.png"></body></html>',
        ),
        mimeType: 'text/html',
      },
      'logo.png': { bytes: MINIMAL_PNG, mimeType: 'image/png' },
    })
    const src = new TextDecoder().decode(fileMap.files['index.html']!.bytes)
    const { pagePlan } = makeHtmlPagePlan('index.html', src, fileMap)
    const { warnings } = buildAssetPlan([pagePlan], [], fileMap)

    expect(warnings.filter((w) => w.kind === 'unresolved-asset')).toHaveLength(0)
  })
})
