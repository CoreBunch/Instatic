import { describe, it, expect } from 'bun:test'
import {
  escapeHtml,
  escapeProps,
  isSafeUrl,
  renderNode,
  publishPage,
  type RenderConfig,
  type RenderAccumulators,
} from '@core/publisher'
import type { ModuleDefinition, PropertySchema } from '@core/module-engine'
import {
  frameworkColorClassId,
  generateFrameworkColorUtilityClasses,
} from '@core/framework'
import { makeModule, makeRegistry, makePage, makeSite, makeAccumulators } from './helpers'

// Render a node with a throwaway accumulator bag. Tests that need to inspect
// the accumulated CSS / hole / loop sets build their own `acc` and pass it.
function render(
  nodeId: string,
  config: RenderConfig,
  acc: RenderAccumulators = makeAccumulators(),
): string {
  return renderNode(nodeId, config, acc)
}

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes & < > " \'', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
    expect(escapeHtml('say "hello" & \'world\'')).toBe(
      'say &quot;hello&quot; &amp; &#x27;world&#x27;',
    )
  })

  it('passes through safe plain text unchanged', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World')
    expect(escapeHtml('foo bar 42')).toBe('foo bar 42')
  })

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// isSafeUrl
// ---------------------------------------------------------------------------

describe('isSafeUrl', () => {
  it('blocks javascript: URLs', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeUrl('  javascript:alert(1)')).toBe(false) // leading whitespace
    expect(isSafeUrl('JAVASCRIPT:alert(1)')).toBe(false)   // case insensitive
    expect(isSafeUrl('\tjavascript:void(0)')).toBe(false)  // tab prefix
  })

  it('blocks vbscript: URLs', () => {
    expect(isSafeUrl('vbscript:MsgBox(1)')).toBe(false)
    expect(isSafeUrl('VBSCRIPT:MsgBox(1)')).toBe(false)
  })

  it('blocks javascript: with internal tab/newline/CR (WHATWG bypass, Advisory A)', () => {
    expect(isSafeUrl('java\tscript:alert(1)')).toBe(false)
    expect(isSafeUrl('java\nscript:alert(1)')).toBe(false)
    expect(isSafeUrl('java\rscript:alert(1)')).toBe(false)
    expect(isSafeUrl('javascript\t:')).toBe(false)
  })

  it('allows https, http, relative, and anchor URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true)
    expect(isSafeUrl('http://example.com/path?q=1')).toBe(true)
    expect(isSafeUrl('/relative/path')).toBe(true)
    expect(isSafeUrl('#section')).toBe(true)
    expect(isSafeUrl('')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// escapeProps
// ---------------------------------------------------------------------------

describe('escapeProps', () => {
  // escapeProps dispatches PER KEY on the prop's declared control `type` in the
  // module schema — NOT on the key NAME. These schemas use deliberately
  // off-heuristic key names (pageBody, assetPath, diagram) to prove the router
  // follows the type, not a name-suffix guess.
  const schema: PropertySchema = {
    text: { type: 'text', label: 'Text' },
    href: { type: 'url', label: 'Link' },
    src: { type: 'url', label: 'Source' },
    poster: { type: 'image', label: 'Poster' },
    videoUrl: { type: 'media', label: 'Video', mediaKind: 'video' },
    pageBody: { type: 'richtext', label: 'Body' },
    diagram: { type: 'svg', label: 'Diagram' },
    level: { type: 'number', label: 'Level' },
  }

  it('HTML-escapes plain (text-typed) string props', () => {
    const result = escapeProps({ text: '<b>bold</b> & "quoted"' }, schema)
    expect(result.text).toBe('&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;')
  })

  it('replaces javascript: url-typed props with #', () => {
    expect(escapeProps({ href: 'javascript:alert(1)' }, schema).href).toBe('#')
    expect(escapeProps({ src: 'javascript:evil()' }, schema).src).toBe('#')
  })

  it('allows safe url-typed values, unescaped (& survives for safeUrl)', () => {
    expect(escapeProps({ href: 'https://example.com' }, schema).href).toBe('https://example.com')
    expect(escapeProps({ src: '/images/logo.png' }, schema).src).toBe('/images/logo.png')
    expect(escapeProps({ href: 'https://x.com/?a=1&b=2' }, schema).href).toBe('https://x.com/?a=1&b=2')
  })

  it('routes richtext-typed props by TYPE even when the name misses the old suffix', () => {
    // `pageBody` does NOT end in html/richtext — the old name heuristic would
    // have HTML-escaped it (breaking markup AND leaving stored XSS unsanitised).
    const result = escapeProps(
      { pageBody: '<p>ok</p><script>alert(1)</script>' },
      schema,
    )
    expect(result.pageBody).not.toContain('<script>')
    expect(result.pageBody).not.toContain('&lt;p&gt;') // sanitised, not escaped
    expect(result.pageBody).toContain('<p>ok</p>')
  })

  it('routes url-typed props by TYPE even when the name misses the old suffix', () => {
    // `assetPath` matches no URL key/suffix — old heuristic HTML-escaped it,
    // skipping isSafeUrl() so javascript: was NOT blocked and & was broken.
    const urlSchema: PropertySchema = { assetPath: { type: 'url', label: 'Asset' } }
    expect(escapeProps({ assetPath: 'javascript:alert(1)' }, urlSchema).assetPath).toBe('#')
    expect(escapeProps({ assetPath: '/a?x=1&y=2' }, urlSchema).assetPath).toBe('/a?x=1&y=2')
  })

  it('routes svg-typed props by TYPE even when the name is not exactly "svg"', () => {
    const result = escapeProps(
      { diagram: '<svg onload="evil()"><rect/></svg>' },
      schema,
    )
    expect(result.diagram).not.toContain('onload')
    expect(result.diagram).toContain('<svg') // sanitised SVG, not escaped literal
  })

  it('URL-validates image/media-typed props (poster), no double-escape', () => {
    expect(escapeProps({ poster: 'javascript:x' }, schema).poster).toBe('#')
    expect(escapeProps({ poster: '/p.jpg?a=1&b=2' }, schema).poster).toBe('/p.jpg?a=1&b=2')
    expect(escapeProps({ videoUrl: 'javascript:x' }, schema).videoUrl).toBe('#')
  })

  it('HTML-escapes any prop absent from the schema (safe default)', () => {
    const result = escapeProps({ unknownProp: '<script>alert(1)</script>' }, schema)
    expect(result.unknownProp).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('passes through non-string values unchanged', () => {
    const input = { level: 2, visible: true, count: 42, arr: [1, 2] }
    expect(escapeProps(input, schema)).toEqual(input)
  })
})

// ---------------------------------------------------------------------------
// renderNode
// ---------------------------------------------------------------------------

describe('renderNode', () => {
  const headingDef: ModuleDefinition<{ text: string; level: number }> = makeModule(
    'base.text',
    {
      canHaveChildren: false,
      render: (props, _children) => ({
        html: `<h${props.level}>${props.text}</h${props.level}>`,
        css: 'h1,h2,h3,h4,h5,h6 { font-family: sans-serif; }',
      }),
    },
  )

  const containerDef: ModuleDefinition<{ className: string }> = makeModule(
    'base.container',
    {
      canHaveChildren: true,
      render: (props, children) => ({
        html: `<div class="${props.className}">${children.join('')}</div>`,
        css: '.instatic-container { display: block; }',
      }),
    },
  )

  const registry = makeRegistry({
    'base.text': headingDef,
    'base.container': containerDef,
  })
  const site = makeSite()

  function ctx(page: ReturnType<typeof makePage>): RenderConfig {
    return { page, site, registry, breakpointId: undefined }
  }

  it('renders a leaf node', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Hello', level: 1 } },
    })
    const c = ctx(page)
    expect(render('root', c)).toBe('<h1>Hello</h1>')
  })

  it('renders nested children bottom-up', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { className: 'wrapper' },
        children: ['c1', 'c2'],
      },
      c1: { moduleId: 'base.text', props: { text: 'A', level: 2 } },
      c2: { moduleId: 'base.text', props: { text: 'B', level: 3 } },
    })
    const c = ctx(page)
    expect(render('root', c)).toBe(
      '<div class="wrapper"><h2>A</h2><h3>B</h3></div>',
    )
  })

  it('deduplicates CSS by moduleId — 3 heading nodes → 1 CSS entry', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { className: '' },
        children: ['h1', 'h2', 'h3'],
      },
      h1: { moduleId: 'base.text', props: { text: 'A', level: 1 } },
      h2: { moduleId: 'base.text', props: { text: 'B', level: 2 } },
      h3: { moduleId: 'base.text', props: { text: 'C', level: 3 } },
    })
    const acc = makeAccumulators()
    render('root', { page, site, registry, breakpointId: undefined }, acc)
    expect(acc.cssMap.size).toBe(2) // base.text + base.container, NOT 4
    expect(acc.cssMap.get('base.text')).toBe('h1,h2,h3,h4,h5,h6 { font-family: sans-serif; }')
  })

  it('returns empty string for missing nodeId', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: {} } })
    const c = ctx(page)
    expect(render('nonexistent', c)).toBe('')
  })

  it('returns empty string for a hidden node', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Hidden', level: 1 }, hidden: true },
    })
    const c = ctx(page)
    expect(render('root', c)).toBe('')
  })

  it('does not collect CSS for a hidden node', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Hidden', level: 1 }, hidden: true },
    })
    const c = ctx(page)
    const acc = makeAccumulators()
    render('root', c, acc)
    expect(acc.cssMap.size).toBe(0)
  })

  it('renders visible children while omitting hidden children', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { className: 'wrapper' },
        children: ['shown', 'hidden'],
      },
      shown: { moduleId: 'base.text', props: { text: 'Shown', level: 2 } },
      hidden: { moduleId: 'base.text', props: { text: 'Hidden', level: 2 }, hidden: true },
    })
    const c = ctx(page)
    expect(render('root', c)).toBe('<div class="wrapper"><h2>Shown</h2></div>')
  })

  it('prunes a hidden parent without mutating child hidden flags', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { className: 'wrapper' },
        children: ['shown-child', 'hidden-child'],
        hidden: true,
      },
      'shown-child': { moduleId: 'base.text', props: { text: 'Shown', level: 2 } },
      'hidden-child': {
        moduleId: 'base.text',
        props: { text: 'Hidden child', level: 2 },
        hidden: true,
      },
    })
    const c = ctx(page)
    expect(render('root', c)).toBe('')
    expect(page.nodes['shown-child'].hidden).toBe(false)
    expect(page.nodes['hidden-child'].hidden).toBe(true)
  })

  it('emits HTML comment for unknown moduleId', () => {
    const page = makePage({
      root: { moduleId: 'unknown.widget', props: {} },
    })
    const c = ctx(page)
    const html = render('root', c)
    expect(html).toContain('<!-- instatic: unknown module')
    expect(html).toContain('unknown.widget')
  })

  it('emits nothing for a hidden unknown module', () => {
    const page = makePage({
      root: { moduleId: 'unknown.widget', props: {}, hidden: true },
    })
    const c = ctx(page)
    expect(render('root', c)).toBe('')
  })

  it('does not emit a dynamic hole for a hidden dynamic node', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Dynamic', level: 1 }, hidden: true },
    })
    const acc = makeAccumulators()
    const html = render(
      'root',
      { ...ctx(page), dynamicNodeIds: new Set(['root']), publishVersion: 7 },
      acc,
    )
    expect(html).toBe('')
    expect(acc.holeNodeIds.size).toBe(0)
  })

  // Security tests (Constraint #211)
  it('XSS: escapes <script> in text props before render()', () => {
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { text: '<script>alert(1)</script>', level: 1 },
      },
    })
    const c = ctx(page)
    const html = render('root', c)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('XSS: blocks javascript: href before render()', () => {
    const linkDef = makeModule('base.link', {
      schema: { href: { type: 'url', label: 'Link' } },
      render: (props, _) => ({
        html: `<a href="${(props as { href: string }).href}">click</a>`,
      }),
    })
    const reg = makeRegistry({ 'base.link': linkDef })
    const page = makePage({
      root: { moduleId: 'base.link', props: { href: 'javascript:alert(1)' } },
    })
    const html = render('root', { page, site, registry: reg, breakpointId: undefined })
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
  })

  it('applies breakpoint overrides only for schema keys marked breakpointOverridable', () => {
    // Use a module whose schema explicitly opts `level` into per-breakpoint
    // overrides while leaving `text` as content. The publisher must apply
    // the `level` override but ignore the `text` override — content is
    // single-value across all breakpoints.
    const responsiveDef: ModuleDefinition<{ text: string; level: number }> = makeModule(
      'test.responsive-heading',
      {
        canHaveChildren: false,
        schema: {
          text: { type: 'text', label: 'Text' },
          level: { type: 'number', label: 'Level', breakpointOverridable: true },
        },
        render: (props) => ({
          html: `<h${props.level}>${props.text}</h${props.level}>`,
        }),
      },
    )
    const responsiveRegistry = makeRegistry({ 'test.responsive-heading': responsiveDef })
    const page = makePage({
      root: {
        moduleId: 'test.responsive-heading',
        props: { text: 'Desktop', level: 1 },
        breakpointOverrides: { mobile: { text: 'Mobile', level: 2 } },
      },
    })
    const htmlDesktop = render('root', {
      page, site, registry: responsiveRegistry, breakpointId: undefined,
    })
    const htmlMobile = render('root', {
      page, site, registry: responsiveRegistry, breakpointId: 'mobile',
    })

    expect(htmlDesktop).toBe('<h1>Desktop</h1>')
    // `level` overridden to 2; `text` override silently dropped (content prop).
    expect(htmlMobile).toBe('<h2>Desktop</h2>')
  })

  // Regression — parent classes must not bleed into descendants
  // ─────────────────────────────────────────────────────────────────────────────
  // Pre-fix bug: injectClassIntoRootElement used a non-anchored regex that
  // matched the FIRST `class="..."` anywhere in the rendered HTML. When the
  // root tag had no class but a nested descendant did, the parent's class was
  // wrongly prepended to that descendant. With three levels (e.g. outer
  // container with `bg`, inner container with `row`, paragraph with
  // `text-primary`), all three classes piled up on the deepest element:
  //   <p class="bg row text-primary">…</p>
  // The fix anchors the operation to the FIRST opening element tag.
  describe('class injection — parent classes never bleed into descendants', () => {
    // Bare-output stand-ins for base.container / base.text — no default class
    const bareContainerDef = makeModule('base.container', {
      canHaveChildren: true,
      render: (_, children) => ({ html: `<div>${children.join('')}</div>` }),
    })
    const bareTextDef = makeModule('base.text', {
      render: (props, _) => ({
        html: `<p>${(props as { text: string }).text}</p>`,
      }),
    })
    const bareReg = makeRegistry({
      'base.container': bareContainerDef,
      'base.text': bareTextDef,
    })

    it('two-level: parent class lands on parent root, not on its classed child', () => {
      const siteDoc = makeSite({
        styleRules: {
          'row-id': {
            id: 'row-id',
            name: 'row',
            kind: 'class',
            selector: '.row',
            order: 0,
            styles: {},
            contextStyles: {},
            createdAt: 0,
            updatedAt: 0,
          },
          'tprim-id': {
            id: 'tprim-id',
            name: 'text-primary',
            kind: 'class',
            selector: '.text-primary',
            order: 1,
            styles: {},
            contextStyles: {},
            createdAt: 0,
            updatedAt: 0,
          },
        },
      })
      const page = makePage({
        root: {
          moduleId: 'base.container',
          classIds: ['row-id'],
          children: ['p1'],
        },
        p1: { moduleId: 'base.text', props: { text: 'Hi' }, classIds: ['tprim-id'] },
      })
      const html = render('root', {
        page, site: siteDoc, registry: bareReg, breakpointId: undefined,
      })

      expect(html).toBe('<div class="row"><p class="text-primary">Hi</p></div>')
      // Parent class never appears on the descendant
      expect(html).not.toMatch(/<p[^>]*class="[^"]*row/)
    })

    it('three-level: each class lands on its own element (Vamos a la playa repro)', () => {
      const siteDoc = makeSite({
        styleRules: {
          'bg-id': {
            id: 'bg-id',
            name: 'bg',
            kind: 'class',
            selector: '.bg',
            order: 0,
            styles: {},
            contextStyles: {},
            createdAt: 0,
            updatedAt: 0,
          },
          'row-id': {
            id: 'row-id',
            name: 'row',
            kind: 'class',
            selector: '.row',
            order: 1,
            styles: {},
            contextStyles: {},
            createdAt: 0,
            updatedAt: 0,
          },
          'tprim-id': {
            id: 'tprim-id',
            name: 'text-primary',
            kind: 'class',
            selector: '.text-primary',
            order: 2,
            styles: {},
            contextStyles: {},
            createdAt: 0,
            updatedAt: 0,
          },
        },
      })
      const page = makePage({
        outer: {
          moduleId: 'base.container',
          classIds: ['bg-id'],
          children: ['inner'],
        },
        inner: {
          moduleId: 'base.container',
          classIds: ['row-id'],
          children: ['p1'],
        },
        p1: { moduleId: 'base.text', props: { text: 'Vamos a la playa' }, classIds: ['tprim-id'] },
      }, 'outer')
      const html = render('outer', {
        page, site: siteDoc, registry: bareReg, breakpointId: undefined,
      })

      expect(html).toBe(
        '<div class="bg"><div class="row"><p class="text-primary">Vamos a la playa</p></div></div>',
      )
      // Each ancestor class stays on its own element
      expect(html).not.toMatch(/<p[^>]*class="[^"]*\bbg\b/)
      expect(html).not.toMatch(/<p[^>]*class="[^"]*\brow\b/)
      expect(html).not.toMatch(/<div class="row"[^>]*>[\s\S]*<div[^>]*class="[^"]*\bbg\b/)
    })

    it('multi-class on root: prepends to existing class on the same element', () => {
      // This locks in the original Case-1 behaviour for the case it was meant
      // to handle: a module render() that already emits a class on the root.
      const classedDef = makeModule('base.classed', {
        render: () => ({ html: '<button class="instatic-btn">Click</button>' }),
      })
      const reg = makeRegistry({ 'base.classed': classedDef })
      const siteDoc = makeSite({
        styleRules: {
          'cta-id': {
            id: 'cta-id',
            name: 'cta',
            kind: 'class',
            selector: '.cta',
            order: 0,
            styles: {},
            contextStyles: {},
            createdAt: 0,
            updatedAt: 0,
          },
        },
      })
      const page = makePage({
        root: { moduleId: 'base.classed', classIds: ['cta-id'] },
      })
      const html = render('root', {
        page, site: siteDoc, registry: reg, breakpointId: undefined,
      })

      expect(html).toBe('<button class="cta instatic-btn">Click</button>')
    })

    it('html starting with a comment: skips the comment and classes the first element', () => {
      const wrappedDef = makeModule('base.wrapped', {
        render: () => ({ html: '<!-- marker --><section><p>x</p></section>' }),
      })
      const reg = makeRegistry({ 'base.wrapped': wrappedDef })
      const siteDoc = makeSite({
        styleRules: {
          'h-id': {
            id: 'h-id',
            name: 'hero',
            kind: 'class',
            selector: '.hero',
            order: 0,
            styles: {},
            contextStyles: {},
            createdAt: 0,
            updatedAt: 0,
          },
        },
      })
      const page = makePage({
        root: { moduleId: 'base.wrapped', classIds: ['h-id'] },
      })
      const html = render('root', {
        page, site: siteDoc, registry: reg, breakpointId: undefined,
      })

      expect(html).toBe('<!-- marker --><section class="hero"><p>x</p></section>')
    })
  })

  // -------------------------------------------------------------------------
  // Inline styles — node.inlineStyles → style="" on the root element
  // -------------------------------------------------------------------------

  describe('inline styles — node.inlineStyles emit a style attribute', () => {
    const bareContainerDef = makeModule('base.container', {
      canHaveChildren: true,
      render: (_, children) => ({ html: `<div>${children.join('')}</div>` }),
    })
    const reg = makeRegistry({ 'base.container': bareContainerDef })

    it('emits a style attribute, sanitised and HTML-escaped, from inlineStyles', () => {
      const page = makePage({
        root: {
          moduleId: 'base.container',
          inlineStyles: { backgroundImage: `url('/uploads/media/hero.png')`, color: 'red' },
        },
      })
      const html = render('root', {
        page, site, registry: reg, breakpointId: undefined,
      })
      // Single-quotes in the url() are escaped for the double-quoted attribute.
      expect(html).toContain('style="')
      expect(html).toContain('background-image: url(&#x27;/uploads/media/hero.png&#x27;)')
      expect(html).toContain('color: red')
    })

    it('drops a dangerous declaration value but keeps the safe ones', () => {
      const page = makePage({
        root: {
          moduleId: 'base.container',
          inlineStyles: { color: 'expression(alert(1))', display: 'block' },
        },
      })
      const html = render('root', {
        page, site, registry: reg, breakpointId: undefined,
      })
      expect(html).not.toContain('expression')
      expect(html).toContain('display: block')
    })

    it('coexists with classIds — both class and style land on the root', () => {
      const siteDoc = makeSite({
        styleRules: {
          'c-id': {
            id: 'c-id',
            name: 'card',
            kind: 'class',
            selector: '.card',
            order: 0,
            styles: {},
            contextStyles: {},
            createdAt: 0,
            updatedAt: 0,
          },
        },
      })
      const page = makePage({
        root: { moduleId: 'base.container', classIds: ['c-id'], inlineStyles: { color: 'blue' } },
      })
      const html = render('root', {
        page, site: siteDoc, registry: reg, breakpointId: undefined,
      })
      expect(html).toContain('class="card"')
      expect(html).toContain('style="color: blue"')
    })
  })
})

// ---------------------------------------------------------------------------
// publishPage
// ---------------------------------------------------------------------------

describe('publishPage', () => {
  const headingDef = makeModule('base.text', {
    render: (props, _) => ({
      html: `<h1>${(props as { text: string }).text}</h1>`,
      css: 'h1 { color: black; }',
    }),
  })
  const registry = makeRegistry({ 'base.text': headingDef })
  const site = makeSite()

  it('produces a complete DOCTYPE html document', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Hello' } },
    })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<title>Test Page</title>')
    expect(html).toContain('<h1>Hello</h1>')
  })

  it('filename is index.html for slug "index"', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.slug = 'index'
    const { filename } = publishPage(page, site, registry)
    expect(filename).toBe('index.html')
  })

  it('filename is derived from slug for non-index pages', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.slug = 'about-us'
    const { filename } = publishPage(page, site, registry)
    expect(filename).toBe('about-us.html')
  })

  it('injects deduplicated CSS — heading CSS appears exactly once', () => {
    const containerDef = makeModule('base.container', {
      canHaveChildren: true,
      render: (_, children) => ({ html: `<div>${children.join('')}</div>` }),
    })
    const reg = makeRegistry({
      'base.container': containerDef,
      'base.text': headingDef,
    })
    const page = makePage({
      root: { moduleId: 'base.container', props: {}, children: ['h1', 'h2', 'h3'] },
      h1: { moduleId: 'base.text', props: { text: 'A' } },
      h2: { moduleId: 'base.text', props: { text: 'B' } },
      h3: { moduleId: 'base.text', props: { text: 'C' } },
    })
    const { html } = publishPage(page, site, reg)
    const count = (html.match(/h1 \{ color: black; \}/g) ?? []).length
    expect(count).toBe(1) // deduplicated — not 3
  })

  it('does not emit ghost design tokens on a fresh project', () => {
    // A brand-new project has no framework Color tokens, no framework
    // typography, no framework spacing, and no fonts. The published
    // `framework.css` body must therefore be empty — no `:root {}` block,
    // no leftover `--color-*` declarations from any legacy default. The
    // legacy `site.settings.colorTokens` field has been removed entirely;
    // all color tokens now flow through `framework.colors` (managed by
    // the editor's Colors panel).
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, site, registry)
    expect(html).not.toContain('--color-primary')
    expect(html).not.toContain('--color-secondary')
    expect(html).not.toContain('--color-accent')
    expect(html).not.toContain('--color-surface')
    expect(html).not.toContain('--color-on-surface')
  })

  it('ships the publisher reset before module CSS so canvas and front end agree', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, site, registry)
    // Reset rules — verify both core box-model and body baseline reach the page.
    expect(html).toContain(':where(*, *::before, *::after) { box-sizing: border-box; }')
    expect(html).toContain(':where(*) { margin: 0; padding: 0; }')
    expect(html).toContain('font-family: system-ui')
    // Cascade order: reset must appear before module CSS so module rules win.
    const resetIndex = html.indexOf(':where(*, *::before, *::after)')
    const moduleIndex = html.indexOf('h1 { color: black; }')
    expect(resetIndex).toBeGreaterThan(-1)
    expect(moduleIndex).toBeGreaterThan(resetIndex)
  })

  // ─── External CSS mode (per-site bundle served at /_instatic/css/) ──────────────

  it('emits four <link> tags pointing at the site bundle in external mode', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const cssBundle = {
      reset: { bundle: 'reset' as const, filename: 'reset-aaaaaaaaaaaa.css', hash: 'aaaaaaaaaaaa', content: ':where(*) { margin: 0; }' },
      framework: { bundle: 'framework' as const, filename: 'framework-bbbbbbbbbbbb.css', hash: 'bbbbbbbbbbbb', content: ':root { --x: 1; }' },
      style: { bundle: 'style' as const, filename: 'style-cccccccccccc.css', hash: 'cccccccccccc', content: '.foo { color: red; }' },
      userStyles: { bundle: 'userStyles' as const, filename: 'userStyles-dddddddddddd.css', hash: 'dddddddddddd', content: 'body { background: tomato; }' },
    }
    const { html } = publishPage(page, site, registry, {
      cssEmission: 'external',
      cssBundle,
    })

    expect(html).toContain('<link rel="stylesheet" href="/_instatic/css/reset-aaaaaaaaaaaa.css">')
    expect(html).toContain('<link rel="stylesheet" href="/_instatic/css/framework-bbbbbbbbbbbb.css">')
    expect(html).toContain('<link rel="stylesheet" href="/_instatic/css/style-cccccccccccc.css">')
    expect(html).toContain('<link rel="stylesheet" href="/_instatic/css/userStyles-dddddddddddd.css">')

    // No inline <style> block for site-wide CSS in external mode.
    expect(html).not.toMatch(/<style>\s*\n[^<]*:where\(\*\)/)

    // Cascade order: reset → framework → style → userStyles (last loaded wins ties).
    const resetIdx = html.indexOf('reset-aaaaaaaaaaaa.css')
    const frameworkIdx = html.indexOf('framework-bbbbbbbbbbbb.css')
    const styleIdx = html.indexOf('style-cccccccccccc.css')
    const userIdx = html.indexOf('userStyles-dddddddddddd.css')
    expect(resetIdx).toBeLessThan(frameworkIdx)
    expect(frameworkIdx).toBeLessThan(styleIdx)
    expect(styleIdx).toBeLessThan(userIdx)
  })

  it('skips empty bundle files in external mode (no zero-byte <link> requests)', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const cssBundle = {
      reset: { bundle: 'reset' as const, filename: 'reset-aaaaaaaaaaaa.css', hash: 'aaaaaaaaaaaa', content: ':where(*) { margin: 0; }' },
      // Empty framework + style + userStyles on a fresh site (no framework,
      // no classes, no user-authored CSS files).
      framework: { bundle: 'framework' as const, filename: 'framework-bbbbbbbbbbbb.css', hash: 'bbbbbbbbbbbb', content: '' },
      style: { bundle: 'style' as const, filename: 'style-cccccccccccc.css', hash: 'cccccccccccc', content: '' },
      userStyles: { bundle: 'userStyles' as const, filename: 'userStyles-dddddddddddd.css', hash: 'dddddddddddd', content: '' },
    }
    const { html } = publishPage(page, site, registry, {
      cssEmission: 'external',
      cssBundle,
    })

    expect(html).toContain('reset-aaaaaaaaaaaa.css')
    expect(html).not.toContain('framework-bbbbbbbbbbbb.css')
    expect(html).not.toContain('style-cccccccccccc.css')
    expect(html).not.toContain('userStyles-dddddddddddd.css')
  })

  it('uses a custom cssAssetBaseUrl when provided', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const cssBundle = {
      reset: { bundle: 'reset' as const, filename: 'reset-aaaaaaaaaaaa.css', hash: 'aaaaaaaaaaaa', content: 'x' },
      framework: { bundle: 'framework' as const, filename: 'framework-bbbbbbbbbbbb.css', hash: 'bbbbbbbbbbbb', content: 'x' },
      style: { bundle: 'style' as const, filename: 'style-cccccccccccc.css', hash: 'cccccccccccc', content: 'x' },
      userStyles: { bundle: 'userStyles' as const, filename: 'userStyles-dddddddddddd.css', hash: 'dddddddddddd', content: 'x' },
    }
    const { html } = publishPage(page, site, registry, {
      cssEmission: 'external',
      cssBundle,
      cssAssetBaseUrl: 'https://cdn.example.com/css/',
    })
    expect(html).toContain('href="https://cdn.example.com/css/reset-aaaaaaaaaaaa.css"')
  })

  it('throws when external mode is requested without a bundle', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    expect(() => publishPage(page, site, registry, { cssEmission: 'external' })).toThrow(
      'cssEmission "external" requires options.cssBundle',
    )
  })

  it('inline mode (default) still emits a <style> block and no link tags', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('<style>')
    expect(html).not.toMatch(/<link\s+rel="stylesheet"\s+href="\/_instatic\/css\//)
  })

  it('injects framework color variables and used generated utility CSS', () => {
    const colors = {
      tokens: [
        {
          id: 'primary-token',
          category: 'Brand',
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
    const textClassId = frameworkColorClassId('primary-token', 'base', 'text')
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { text: 'Hi' },
        classIds: [textClassId],
      },
    })
    const proj = makeSite({
      pages: [page],
      settings: {
        ...makeSite().settings,
        framework: { colors },
      },
      classes: generateFrameworkColorUtilityClasses(colors),
    })

    const { html } = publishPage(page, proj, registry)

    expect(html).toContain(':root.theme-alt')
    expect(html).toContain(':root.theme-default .theme-inverted')
    expect(html).not.toContain('theme-dark')
    expect(html).not.toContain('theme-light')
    expect(html).toContain('--primary: hsla(238, 100%, 62%, 1);')
    expect(html).toContain('--primary: hsla(238, 100%, 42%, 1);')
    expect(html).toContain('.text-primary')
    expect(html).toContain('color: var(--primary);')
    expect(html).not.toContain('cf-theme')
  })

  it('CSP: every published page includes Content-Security-Policy meta tag (Constraint #227)', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'CSP test' } } })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain("script-src 'none'")
    expect(html).toContain("default-src 'self'")
  })

  it('CSS injection: </style> in module CSS is stripped before injection (Constraint #228)', () => {
    // The attack: a module returns CSS containing </style> to escape the <style> block
    // and inject a <script>. After sanitization, </style> is removed, so the <script>
    // text remains INSIDE the <style> block where it is harmless raw text (not parsed as HTML).
    const evilModuleDef = makeModule('evil.module', {
      render: (_props, _children) => ({
        html: '<p>hello</p>',
        css: 'p { color: red; } </style><script>alert(1)</script><style>',
      }),
    })
    const reg = makeRegistry({ 'evil.module': evilModuleDef })
    const page = makePage({ root: { moduleId: 'evil.module', props: {} } })
    const { html } = publishPage(page, site, reg)
    // The dangerous sequence is </style> immediately followed by something outside style.
    // After sanitization the </style> from the module is gone — only the real closing tag remains.
    expect(html).not.toMatch(/<\/style>\s*<script/)
    // The style block closes properly at the end of <head>
    expect(html).toContain('</style>\n</head>')
  })

  it('CSS injection: </style> in design token value is stripped (Advisory C)', () => {
    // Token values are sanitized via sanitizeCssTokenValue(); {} and </style> are removed.
    const proj = makeSite({
      settings: {
        ...makeSite().settings,
        colorTokens: { '--evil': 'red} </style><script>alert(1)</script><style> :root{' },
      },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, proj, registry)
    // </style> was stripped — style block does not close prematurely
    expect(html).not.toMatch(/<\/style>\s*<script/)
    expect(html).toContain('</style>\n</head>')
    // { and } stripped — cannot escape :root {} block to inject rules
    expect(html).not.toContain('display: none')
  })

  it('URL validation: javascript: in faviconUrl is dropped (Advisory B)', () => {
    const proj = makeSite({
      settings: { ...makeSite().settings, faviconUrl: 'javascript:alert(1)' },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, proj, registry)
    expect(html).not.toContain('javascript:')
    // No <link rel="icon"> emitted when faviconUrl is unsafe
    expect(html).not.toContain('rel="icon"')
  })

  // WCAG 2.1 AA SC 3.1.1 — lang attribute (Constraint #317 / UX review)
  it('lang="en" by default when site.settings.language is unset', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('<html lang="en">')
  })

  it('lang attribute reflects site.settings.language when set', () => {
    const proj = makeSite({
      settings: { ...makeSite().settings, language: 'fr' },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Bonjour' } } })
    const { html } = publishPage(page, proj, registry)
    expect(html).toContain('<html lang="fr">')
  })

  it('XSS: malicious language value is HTML-escaped in lang attribute', () => {
    const proj = makeSite({
      settings: { ...makeSite().settings, language: '"><script>alert(1)</script>' },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, proj, registry)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  // ZIP filename / path-traversal safety (Constraint #229 / CWE-22)
  it('slug with path traversal sequences produces a safe filename', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.slug = '../../etc/passwd'
    const { filename } = publishPage(page, site, registry)
    // slugToFilename whitelist-strips all non [a-z0-9-] chars — slashes and dots become dashes
    expect(filename).not.toContain('..')
    expect(filename).not.toContain('/')
    expect(filename).not.toContain('\\')
    expect(filename).toMatch(/^[a-z0-9-]+\.html$/)
  })

  it('slug with null bytes produces a safe filename', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.slug = 'about\x00page'
    const { filename } = publishPage(page, site, registry)
    expect(filename).not.toContain('\x00')
    expect(filename).toMatch(/^[a-z0-9-]+\.html$/)
  })

  it('has zero editor artifacts in output', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Published' } },
    })
    const { html } = publishPage(page, site, registry)
    expect(html).not.toContain('data-reactroot')
    expect(html).not.toContain('data-testid')
    expect(html).not.toContain('__editor')
    expect(html).not.toContain('zustand')
  })

  it('uses the page seo title for <title> when set', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.seo = { title: 'My Site — Home', description: 'A fine page.' }
    const { html } = publishPage(page, makeSite(), registry)
    expect(html).toContain('<title>My Site — Home</title>')
    expect(html).toContain('<meta name="description" content="A fine page.">')
  })

  it('interpolates the site title pattern around the page title', () => {
    const proj = makeSite({
      settings: {
        ...makeSite().settings,
        seo: { titlePattern: '{page.title} — {site.name}' },
      },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, proj, registry)
    expect(html).toContain(`<title>${page.title} — ${proj.name}</title>`)
  })

  it('emits OG/X tags and noindex from the seo object', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.seo = {
      title: 'T',
      ogImage: '/img.png',
      ogImageAlt: 'An image',
      noindex: true,
    }
    const { html } = publishPage(page, makeSite(), registry)
    expect(html).toContain('<meta name="robots" content="noindex">')
    expect(html).toContain('<meta property="og:title" content="T">')
    expect(html).toContain('<meta property="og:image" content="/img.png">')
    expect(html).toContain('<meta property="og:image:alt" content="An image">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    // No origin available in the core fallback — absolute URLs must be omitted.
    expect(html).not.toContain('rel="canonical"')
    expect(html).not.toContain('og:url')
  })

  it('XSS: escapes seo title with special chars', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.seo = { title: '<script>alert(1)</script>' }
    const { html } = publishPage(page, makeSite(), registry)
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })
})
