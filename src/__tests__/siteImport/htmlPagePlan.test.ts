/**
 * Unit tests for htmlPagePlan — HTML→PagePlan transformation.
 */

import { describe, it, expect } from 'bun:test'
// Self-registers all base modules with the global registry so importHtml works
import '@modules/base'
import { makeHtmlPagePlan, deriveSlug, prettifyTitle, resolveHref } from '@core/siteImport'
import { makeSampleFileMap } from './fixtures'

// ---------------------------------------------------------------------------
// deriveSlug
// ---------------------------------------------------------------------------

describe('deriveSlug', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(deriveSlug('Hero Lab.html')).toBe('hero-lab')
  })

  it('strips extension', () => {
    expect(deriveSlug('about.html')).toBe('about')
    expect(deriveSlug('contact.htm')).toBe('contact')
  })

  it('collapses consecutive non-alphanumerics', () => {
    expect(deriveSlug('my--page_name.html')).toBe('my-page-name')
  })

  it('strips leading and trailing hyphens', () => {
    expect(deriveSlug('-odd-.html')).toBe('odd')
  })

  it('keeps parent path segments for nested non-index pages', () => {
    expect(deriveSlug('pages/about.html')).toBe('pages/about')
  })

  it('maps nested index.html files to their directory path', () => {
    expect(deriveSlug('documentation/index.html')).toBe('documentation')
    expect(deriveSlug('docs/api/index.html')).toBe('docs/api')
  })

  it('index.html → "index"', () => {
    expect(deriveSlug('index.html')).toBe('index')
  })

  it('sanitises each nested path segment independently', () => {
    expect(deriveSlug('Docs/API Reference.html')).toBe('docs/api-reference')
  })

  it('falls back to a safe segment for degenerate nested filenames', () => {
    expect(deriveSlug('docs/----.html')).toBe('docs/page')
  })

  it('collapses unusable directory segments', () => {
    expect(deriveSlug('---/about.html')).toBe('about')
  })

  it('falls back to "page" for degenerate filenames', () => {
    expect(deriveSlug('----.html')).toBe('page')
  })
})

// ---------------------------------------------------------------------------
// prettifyTitle
// ---------------------------------------------------------------------------

describe('prettifyTitle', () => {
  it('title-cases hyphenated names', () => {
    expect(prettifyTitle('hero-lab.html')).toBe('Hero Lab')
  })

  it('title-cases underscored names', () => {
    expect(prettifyTitle('about_us.html')).toBe('About Us')
  })

  it('strips the path prefix, uses only the filename', () => {
    expect(prettifyTitle('pages/contact.html')).toBe('Contact')
  })
})

// ---------------------------------------------------------------------------
// resolveHref
// ---------------------------------------------------------------------------

describe('resolveHref', () => {
  it('resolves root-relative href (leading /)', () => {
    expect(resolveHref('/assets/style.css', 'index.html')).toBe('assets/style.css')
  })

  it('resolves relative href against HTML directory', () => {
    expect(resolveHref('../css/main.css', 'pages/about.html')).toBe('css/main.css')
  })

  it('resolves simple sibling href', () => {
    expect(resolveHref('style.css', 'index.html')).toBe('style.css')
  })

  it('resolves nested relative href', () => {
    expect(resolveHref('./main.css', 'styles/base.css')).toBe('styles/main.css')
  })

  it('returns null for http:// URLs', () => {
    expect(resolveHref('https://cdn.example.com/style.css', 'index.html')).toBeNull()
  })

  it('returns null for // protocol-relative URLs', () => {
    expect(resolveHref('//cdn.example.com/x.css', 'index.html')).toBeNull()
  })

  it('returns null for data: URIs', () => {
    expect(resolveHref('data:text/css,body{}', 'index.html')).toBeNull()
  })

  it('returns null for fragment-only hrefs', () => {
    expect(resolveHref('#section', 'index.html')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// makeHtmlPagePlan
// ---------------------------------------------------------------------------

describe('makeHtmlPagePlan', () => {
  const fileMap = makeSampleFileMap()

  it('extracts title from <title> tag', () => {
    const { pagePlan } = makeHtmlPagePlan('index.html', fileMap.files['index.html']!.bytes instanceof Uint8Array
      ? new TextDecoder().decode(fileMap.files['index.html']!.bytes)
      : '', fileMap)
    expect(pagePlan.title).toBe('Home Page')
  })

  it('derives slug from filename', () => {
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    expect(pagePlan.slug).toBe('index')
  })

  it('derives nested index slugs from their directory path', () => {
    const html = `<html><body><h1>Docs</h1></body></html>`
    const { pagePlan } = makeHtmlPagePlan('documentation/index.html', html, fileMap)
    expect(pagePlan.slug).toBe('documentation')
  })

  it('resolves linked CSS paths to FileMap keys', () => {
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    expect(pagePlan.linkedCssPaths).toContain('styles/main.css')
    expect(pagePlan.linkedCssPaths).toContain('styles/theme.css')
  })

  it('resolves linked script paths with classic/module format', () => {
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    expect(pagePlan.scripts).toEqual([
      { kind: 'external', path: 'scripts/vendor.js', format: 'classic' },
      { kind: 'external', path: 'scripts/app.js', format: 'module' },
    ])
  })

  it('preserves executable inline scripts in source order with linked scripts', () => {
    const html = `<html><body>
      <script>var duration = '500', easing = 'swing';</script>
      <script src="scripts/vendor.js"></script>
      <script type="application/json">{"duration": 500}</script>
      <script type="module">window.inlineModuleLoaded = true</script>
      <script src="scripts/app.js" type="module"></script>
    </body></html>`

    const { pagePlan } = makeHtmlPagePlan('index.html', html, fileMap)

    expect(pagePlan.scripts).toEqual([
      {
        kind: 'inline',
        path: 'index.html-inline-script-1.js',
        content: "var duration = '500', easing = 'swing';",
        format: 'classic',
      },
      { kind: 'external', path: 'scripts/vendor.js', format: 'classic' },
      {
        kind: 'inline',
        path: 'index.html-inline-script-2.js',
        content: 'window.inlineModuleLoaded = true',
        format: 'module',
      },
      { kind: 'external', path: 'scripts/app.js', format: 'module' },
    ])
  })

  it('emits missing-stylesheet warning for unknown CSS hrefs', () => {
    const html = `<html>
<head><link rel="stylesheet" href="styles/nonexistent.css"></head>
<body><p>Hi</p></body>
</html>`
    const { warnings } = makeHtmlPagePlan('index.html', html, fileMap)
    const warn = warnings.find((w) => w.kind === 'missing-stylesheet')
    expect(warn).toBeDefined()
    expect(warn!.path).toBe('styles/nonexistent.css')
  })

  it('emits missing-script warning for unknown script src values', () => {
    const html = `<html>
<body><script src="scripts/missing.js"></script></body>
</html>`
    const { warnings } = makeHtmlPagePlan('index.html', html, fileMap)
    const warn = warnings.find((w) => w.kind === 'missing-script')
    expect(warn).toBeDefined()
    expect(warn!.path).toBe('scripts/missing.js')
  })

  it('falls back to prettified filename when <title> is absent', () => {
    const html = `<html><body><h1>Hello</h1></body></html>`
    const { pagePlan } = makeHtmlPagePlan('about.html', html, fileMap)
    expect(pagePlan.title).toBe('About')
  })

  it('produces a nodeFragment with rootIds', () => {
    const { pagePlan } = makeHtmlPagePlan('index.html', new TextDecoder().decode(fileMap.files['index.html']!.bytes), fileMap)
    expect(pagePlan.nodeFragment.rootIds.length).toBeGreaterThan(0)
    expect(Object.keys(pagePlan.nodeFragment.nodes).length).toBeGreaterThan(0)
  })

  it('uses the shared HTML importer so Super Import respects Phase 3 claim semantics', () => {
    // Phase 3: form primitives only claim elements that match their
    // data-instatic-* selectors (or, for label/button, bare tag selectors).
    // Raw <form>, <input>, and <textarea> become DOM-native nodes; only
    // <label> and <button type="submit"> get module overlays.
    const html = `<html><body>
      <form id="lead">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required>
        <button type="submit">Send</button>
      </form>
    </body></html>`
    const { pagePlan } = makeHtmlPagePlan('lead.html', html, fileMap)
    const form = pagePlan.nodeFragment.nodes[pagePlan.nodeFragment.rootIds[0]!]!

    expect(form.moduleId).toBe('')
    expect(form.tag).toBe('form')
    expect(form.attributes?.id).toBe('lead')
    expect(form.children).toHaveLength(3)

    const label = pagePlan.nodeFragment.nodes[form.children[0]!]!
    expect(label.moduleOverlay?.moduleId).toBe('base.label')
    expect(label.moduleOverlay?.props.text).toBe('Email')

    const input = pagePlan.nodeFragment.nodes[form.children[1]!]!
    expect(input.moduleId).toBe('')
    expect(input.tag).toBe('input')

    const submit = pagePlan.nodeFragment.nodes[form.children[2]!]!
    expect(submit.moduleOverlay?.moduleId).toBe('base.submit')
    expect(submit.moduleOverlay?.props.label).toBe('Send')
  })

  it('sets source to the HTML file path', () => {
    const { pagePlan } = makeHtmlPagePlan('about.html', new TextDecoder().decode(fileMap.files['about.html']!.bytes), fileMap)
    expect(pagePlan.source).toBe('about.html')
  })

  it('ignores external stylesheet hrefs', () => {
    const html = `<html>
<head>
  <link rel="stylesheet" href="https://cdn.example.com/styles.css">
  <link rel="stylesheet" href="styles/main.css">
</head>
<body><p>Hi</p></body>
</html>`
    const { pagePlan, warnings } = makeHtmlPagePlan('index.html', html, fileMap)
    // Only the local CSS should appear
    expect(pagePlan.linkedCssPaths).toHaveLength(1)
    expect(pagePlan.linkedCssPaths[0]).toBe('styles/main.css')
    // No warning for external href
    expect(warnings.filter((w) => w.kind === 'missing-stylesheet')).toHaveLength(0)
  })
})
