/**
 * Publisher Integration Tests — Real modules through the full pipeline
 *
 * These tests exercise the COMPLETE publisher pipeline:
 *   escapeProps() → module render() → published HTML
 *
 * They use REAL base modules (not mocks) to catch the double-escaping bug
 * (CWE-116 / Task #260) that isolation tests cannot detect.
 *
 * Regression test for: publisher escapeProps() HTML-escapes plain string props,
 * but base modules ALSO called escapeHtml() internally — resulting in text like
 * "Hello & World" → "Hello &amp;amp; World" in published output.
 */

import { describe, it, expect } from 'bun:test'
import { publishPage, renderNode, type RenderConfig } from '@core/publisher'
import { makePage, makeSite, makeModule, makeRegistry, makeAccumulators } from './helpers'

// Import REAL base modules — they self-register on import
import { TextModule } from '@modules/base/text'
import { ButtonModule } from '@modules/base/button'
import { LinkModule } from '@modules/base/link'
import { ImageModule } from '@modules/base/image'
import { ContainerModule } from '@modules/base/container'
import { ListModule } from '@modules/base/list'
import '@modules/base/forms'
import '@modules/base/svg'
import { registry } from '@core/module-engine'

// Confirm real modules are registered
const REAL_REGISTRY = registry

function realCtx(page: ReturnType<typeof makePage>): RenderConfig {
  return {
    page,
    site: makeSite(),
    registry: REAL_REGISTRY,
    breakpointId: undefined,
  }
}

// Render with a throwaway accumulator bag — none of these tests inspect the
// accumulated CSS / hole / loop sets.
function render(nodeId: string, config: RenderConfig): string {
  return renderNode(nodeId, config, makeAccumulators())
}

// ---------------------------------------------------------------------------
// Double-escape regression (CWE-116 — the core bug being fixed)
// ---------------------------------------------------------------------------

describe('Publisher + real modules — single-level HTML escaping (CWE-116 regression)', () => {
  it('text: "Hello & World" appears as &amp; NOT &amp;amp; in published HTML', () => {
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { ...TextModule.defaults, text: 'Hello & World', tag: 'h1' },
      },
    })
    const html = render('root', realCtx(page))
    // Single escape: browser shows "Hello & World"
    expect(html).toContain('Hello &amp; World')
    // Double-escape would produce: "Hello &amp;amp; World" — browser shows "Hello &amp; World"
    expect(html).not.toContain('&amp;amp;')
  })

  it('text: "<em>styled</em>" text appears with single-escaped entities', () => {
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { ...TextModule.defaults, text: '<em>styled</em>', tag: 'h2' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).toContain('&lt;em&gt;styled&lt;/em&gt;')
    expect(html).not.toContain('&amp;lt;')   // would indicate double-escaping
    expect(html).not.toContain('<em>')        // raw tag must not appear
  })

  it('text paragraph: ampersand in text renders as &amp; not &amp;amp;', () => {
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { ...TextModule.defaults, text: 'Terms & Conditions', tag: 'p' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).toContain('Terms &amp; Conditions')
    expect(html).not.toContain('&amp;amp;')
  })

  it('base.text tag none publishes bare escaped text without a synthetic span wrapper', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { ...ContainerModule.defaults, tag: 'custom', customTag: 'h2' },
        children: ['raw', 'span'],
      },
      raw: {
        moduleId: 'base.text',
        props: { ...TextModule.defaults, text: 'Explore & build ', tag: 'none' },
      },
      span: {
        moduleId: 'base.text',
        props: { ...TextModule.defaults, text: 'with AI', tag: 'span' },
      },
    })

    const html = render('root', realCtx(page))
    expect(html).toBe('<h2>Explore &amp; build <span>with AI</span></h2>')
  })

  it('button: label with & renders as single &amp;', () => {
    const page = makePage({
      root: {
        moduleId: 'base.button',
        props: { ...ButtonModule.defaults, href: '', label: 'Cats & Dogs' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).toContain('Cats &amp; Dogs')
    expect(html).not.toContain('&amp;amp;')
  })

  it('link: text with & renders as single &amp;', () => {
    const page = makePage({
      root: {
        moduleId: 'base.link',
        props: { ...LinkModule.defaults, href: '/about', text: 'About & Contact' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).toContain('About &amp; Contact')
    expect(html).not.toContain('&amp;amp;')
  })

  it('list: items with & render as single &amp;', () => {
    const page = makePage({
      root: {
        moduleId: 'base.list',
        props: { ...ListModule.defaults, items: 'Cats & Dogs\nBirds & Bees' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).toContain('Cats &amp; Dogs')
    expect(html).toContain('Birds &amp; Bees')
    expect(html).not.toContain('&amp;amp;')
  })
})

// ---------------------------------------------------------------------------
// XSS protection — end-to-end (publisher is the sole escaping layer)
// ---------------------------------------------------------------------------

describe('Publisher + real modules — XSS protection (end-to-end)', () => {
  it('text heading: <script> tag in text is fully escaped in published HTML', () => {
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { ...TextModule.defaults, text: '<script>alert(1)</script>', tag: 'h1' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('text paragraph: XSS payload in text is escaped to safe entity-encoded text', () => {
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { ...TextModule.defaults, text: '<img src=x onerror=alert(1)>', tag: 'p' },
      },
    })
    const html = render('root', realCtx(page))
    // Must not contain a live <img> tag — only the entity-encoded representation
    expect(html).not.toContain('<img src=x')
    // The full escaped sequence must appear in the text content
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('button: javascript: href is replaced with # in published HTML', () => {
    const page = makePage({
      root: {
        moduleId: 'base.button',
        props: { ...ButtonModule.defaults, href: 'javascript:alert(1)', label: 'Click' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).not.toContain('javascript:')
    // Degrades to <button> (no href) since safeUrl returns '#' and href===# skips <a>
    expect(html).toContain('Click')
  })

  it('link: javascript: href is replaced with # in published HTML', () => {
    const page = makePage({
      root: {
        moduleId: 'base.link',
        props: { ...LinkModule.defaults, href: 'javascript:alert(1)', text: 'Click' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
  })

  it('image: javascript: src is blocked — rendered as safe fallback', () => {
    const page = makePage({
      root: {
        moduleId: 'base.image',
        props: { ...ImageModule.defaults, src: 'javascript:alert(1)' },
      },
    })
    const html = render('root', realCtx(page))
    // safeUrl() returns '#' for javascript: URLs — the literal scheme must never appear
    expect(html).not.toContain('javascript:')
    // '#' is truthy so the image renders with src="#" (safe placeholder)
    expect(html).toContain('src="#"')
  })
})

// ---------------------------------------------------------------------------
// URL edge cases — data: URIs, protocol-relative, empty href
// ---------------------------------------------------------------------------

describe('Publisher + real modules — URL edge cases', () => {
  it('image: data:text/html URI is blocked by safeUrl() in src attribute', () => {
    const page = makePage({
      root: {
        moduleId: 'base.image',
        props: {
          ...ImageModule.defaults,
          src: 'data:text/html,<script>alert(1)</script>',
        },
      },
    })
    const html = render('root', realCtx(page))
    // data: URI must not appear in src — safeUrl blocks it
    expect(html).not.toContain('data:text/html')
    expect(html).not.toContain('<script>')
  })

  it('link: data: URI is blocked; href falls back to safe value', () => {
    const page = makePage({
      root: {
        moduleId: 'base.link',
        props: { ...LinkModule.defaults, href: 'data:text/html,<h1>xss</h1>', text: 'Click' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).not.toContain('data:text/html')
    expect(html).toContain('Click')
  })

  it('button: relative URL is passed through unchanged (not blocked)', () => {
    const page = makePage({
      root: {
        moduleId: 'base.button',
        props: { ...ButtonModule.defaults, href: '/pricing', label: 'Pricing' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).toContain('/pricing')
    expect(html).toContain('Pricing')
  })

  it('image: HTTPS URL is allowed through as-is', () => {
    const page = makePage({
      root: {
        moduleId: 'base.image',
        props: {
          ...ImageModule.defaults,
          src: 'https://cdn.example.com/hero.jpg',
        },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).toContain('src="https://cdn.example.com/hero.jpg"')
  })
})

// ---------------------------------------------------------------------------
// Quote and multi-character escaping
// ---------------------------------------------------------------------------

describe('Publisher + real modules — quote and multi-character escaping', () => {
  it('text: text with double quote is single-escaped as &quot;', () => {
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { ...TextModule.defaults, text: 'Say "Hello"', tag: 'h3' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).toContain('Say &quot;Hello&quot;')
    expect(html).not.toContain('&amp;quot;')
  })

  it('text paragraph: text with all four special chars escapes correctly once', () => {
    // Tests & < > " together — if any double-escapes, the test fails
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: {
          ...TextModule.defaults,
          text: 'A&B <tag> C>D "quoted"',
          tag: 'p',
        },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).toContain('A&amp;B')
    expect(html).toContain('&lt;tag&gt;')
    expect(html).toContain('C&gt;D')
    expect(html).toContain('&quot;quoted&quot;')
    expect(html).not.toContain('&amp;amp;')
    expect(html).not.toContain('&amp;lt;')
    expect(html).not.toContain('&amp;quot;')
  })

  it('list: items with quotes are single-escaped in <li> elements', () => {
    const page = makePage({
      root: {
        moduleId: 'base.list',
        props: { ...ListModule.defaults, items: '"First"\n"Second"' },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).toContain('&quot;First&quot;')
    expect(html).toContain('&quot;Second&quot;')
    expect(html).not.toContain('&amp;quot;')
  })

  it('image: library alt text with all special chars is single-escaped in attribute', () => {
    // Alt text comes from the resolved library asset, not a per-instance prop.
    // The render() HTML-escapes the raw library value at the attribute boundary.
    const page = makePage({
      root: {
        moduleId: 'base.image',
        props: {
          ...ImageModule.defaults,
          src: '/uploads/img.jpg',
        },
      },
    })
    const mediaAssets = new Map([
      [
        '/uploads/img.jpg',
        {
          publicPath: '/uploads/img.jpg',
          mimeType: 'image/jpeg',
          width: 100,
          height: 100,
          altText: 'AT&T "Premium" Plan <Pro>',
          blurHash: null,
          variants: [],
          posterPath: null,
        },
      ],
    ])
    const html = render('root', { ...realCtx(page), mediaAssets })
    expect(html).toContain('AT&amp;T')
    expect(html).toContain('&quot;Premium&quot;')
    expect(html).toContain('&lt;Pro&gt;')
    expect(html).not.toContain('&amp;amp;')
    expect(html).not.toContain('&amp;quot;')
  })
})

// ---------------------------------------------------------------------------
// Richtext props — publisher pass-through (Constraint #299)
// ---------------------------------------------------------------------------

describe('Publisher — richtext prop pass-through (Constraint #299)', () => {
  /**
   * A minimal module that injects three richtext-typed props directly into
   * output HTML. This simulates any future richtext-capable module (e.g. a
   * WYSIWYG content block).
   *
   * `bodyContent` is deliberately named to MISS the old html/richtext suffix
   * heuristic — it is passed through unescaped purely because its schema
   * declares `type: 'richtext'`, proving escapeProps routes by type, not name.
   *
   * The contract (Constraint #299):
   *   - Publisher's escapeProps() must NOT HTML-escape richtext-typed props.
   *   - DOMPurify is the sanitizer, applied at WRITE TIME (Contribution #411).
   *   - Publisher trusts the pre-sanitized value — re-escaping would break the output.
   */
  const richtextModule = makeModule('test.richtextBlock', {
    schema: {
      richtext: { type: 'richtext', label: 'Richtext' },
      html: { type: 'richtext', label: 'HTML' },
      bodyContent: { type: 'richtext', label: 'Body' },
    },
    render: (props) => ({
      html: `<div class="richtext-block">${(props.richtext as string) ?? ''}${(props.html as string) ?? ''}${(props.bodyContent as string) ?? ''}</div>`,
    }),
  })
  const richtextRegistry = makeRegistry({ 'test.richtextBlock': richtextModule })
  const richtextSite = makeSite()

  function rtCtx(page: ReturnType<typeof makePage>): RenderConfig {
    return {
      page,
      site: richtextSite,
      registry: richtextRegistry,
      breakpointId: undefined,
    }
  }

  it('prop named "richtext" is passed through unescaped — HTML tags are preserved', () => {
    const sanitizedHtml = '<p><strong>Bold text</strong> and <em>italic</em></p>'
    const page = makePage({
      root: { moduleId: 'test.richtextBlock', props: { richtext: sanitizedHtml } },
    })
    const html = render('root', rtCtx(page))
    // HTML tags must survive the publisher pipeline intact (not entity-encoded)
    expect(html).toContain('<p><strong>Bold text</strong>')
    expect(html).not.toContain('&lt;p&gt;')     // NOT double-escaped
    expect(html).not.toContain('&lt;strong&gt;') // NOT double-escaped
  })

  it('prop named "html" is passed through unescaped', () => {
    const sanitizedHtml = '<ul><li>Item one</li><li>Item two</li></ul>'
    const page = makePage({
      root: { moduleId: 'test.richtextBlock', props: { html: sanitizedHtml } },
    })
    const html = render('root', rtCtx(page))
    expect(html).toContain('<ul><li>Item one</li><li>Item two</li></ul>')
    expect(html).not.toContain('&lt;ul&gt;')
  })

  it('richtext-typed prop with an off-heuristic name (bodyContent) is passed through unescaped', () => {
    const sanitizedHtml = '<a href="https://example.com" rel="noopener">Visit site</a>'
    const page = makePage({
      root: { moduleId: 'test.richtextBlock', props: { bodyContent: sanitizedHtml } },
    })
    const html = render('root', rtCtx(page))
    expect(html).toContain('<a href="https://example.com"')
    expect(html).not.toContain('&lt;a ')
  })

  it('plain string prop (non-richtext-keyed) IS HTML-escaped — confirms escaping boundary', () => {
    // "content" is not a richtext-keyed name — it will be HTML-escaped.
    // This test confirms the complement: only richtext-keyed props are passed through.
    const htmlContent = '<p><strong>Bold</strong></p>'
    const plainModule = makeModule('test.plainBlock', {
      render: (props) => ({ html: `<div>${props.content as string}</div>` }),
    })
    const plainRegistry = makeRegistry({ 'test.plainBlock': plainModule })
    const plainPage = makePage({
      root: { moduleId: 'test.plainBlock', props: { content: htmlContent } },
    })
    const html = render('root', {
      page: plainPage,
      site: richtextSite,
      registry: plainRegistry,
      breakpointId: undefined,
    })
    // "content" is a plain string prop — it MUST be HTML-escaped
    expect(html).toContain('&lt;p&gt;')
    expect(html).not.toContain('<p>')
  })

  it('publishPage(): richtext content survives the full document pipeline unescaped', () => {
    // End-to-end: publishPage() must not HTML-escape richtext props at any stage
    const sanitizedHtml = '<p>Hello <strong>World</strong></p>'
    const page = makePage({
      root: { moduleId: 'test.richtextBlock', props: { richtext: sanitizedHtml } },
    })
    const { html: docHtml } = publishPage(page, richtextSite, richtextRegistry)
    // Richtext must appear in the published document without entity encoding
    expect(docHtml).toContain('<p>Hello <strong>World</strong></p>')
    expect(docHtml).not.toContain('&lt;p&gt;')
    expect(docHtml).not.toContain('&lt;strong&gt;')
  })

  it('richtext with nested formatting survives the pipeline — complex HTML preserved', () => {
    const complexHtml = '<h2>Title</h2><p>Para with <a href="/page" rel="noopener">link</a> and <code>code</code>.</p>'
    const page = makePage({
      root: { moduleId: 'test.richtextBlock', props: { richtext: complexHtml } },
    })
    const { html: docHtml } = publishPage(page, richtextSite, richtextRegistry)
    expect(docHtml).toContain('<h2>Title</h2>')
    expect(docHtml).toContain('<a href="/page"')
    expect(docHtml).toContain('<code>code</code>')
    expect(docHtml).not.toContain('&lt;h2&gt;')
    expect(docHtml).not.toContain('&lt;a ')
  })
})

// ---------------------------------------------------------------------------
// publishPage — full document integration
// ---------------------------------------------------------------------------

describe('publishPage() + real modules — end-to-end document', () => {
  it('produces a valid HTML document with correctly escaped content', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: ContainerModule.defaults,
        children: ['h1', 'p1'],
      },
      h1: {
        moduleId: 'base.text',
        props: { ...TextModule.defaults, text: 'Hello & <World>', tag: 'h1' },
      },
      p1: {
        moduleId: 'base.text',
        props: { ...TextModule.defaults, text: 'Terms & "Conditions"', tag: 'p' },
      },
    })

    const site = makeSite()
    const { html } = publishPage(page, site, REAL_REGISTRY)

    // Document structure
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('</html>')

    // Heading: single-escaped, browser shows "Hello & <World>"
    expect(html).toContain('Hello &amp; &lt;World&gt;')
    expect(html).not.toContain('&amp;amp;')   // no double escaping
    expect(html).not.toContain('<World>')      // raw tag not present

    // Paragraph: single-escaped
    expect(html).toContain('Terms &amp; &quot;Conditions&quot;')
    expect(html).not.toContain('&amp;amp;')

    // CSP header present (Constraint #227)
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("script-src 'none'")
  })

  it('image library alt text with & is correctly single-escaped in published output', () => {
    // The publisher attaches resolved library assets to each image node; the
    // module's render() then HTML-escapes the library altText at the attribute
    // boundary so a special-char metadata value can't break out of the attr
    // or get double-escaped on its way through the pipeline.
    const page = makePage({
      root: {
        moduleId: 'base.image',
        props: { ...ImageModule.defaults, src: '/uploads/img.jpg' },
      },
    })
    const site = makeSite()
    const mediaAssets = new Map([
      [
        '/uploads/img.jpg',
        {
          publicPath: '/uploads/img.jpg',
          mimeType: 'image/jpeg',
          width: 100,
          height: 100,
          altText: 'Cat & Dog',
          blurHash: null,
          variants: [],
          posterPath: null,
        },
      ],
    ])
    const { html } = publishPage(page, site, REAL_REGISTRY, { mediaAssets })
    expect(html).toContain('alt="Cat &amp; Dog"')
    expect(html).not.toContain('alt="Cat &amp;amp; Dog"')
  })
})

// ---------------------------------------------------------------------------
// Custom HTML attributes reach every element type
// ---------------------------------------------------------------------------

describe('Publisher + real modules — custom HTML attributes', () => {
  const htmlAttributes = { 'aria-label': 'Custom label', 'data-track': 'cta' }

  for (const [moduleId, props, tag] of [
    ['base.button', {}, 'button'],
    ['base.input', {}, 'input'],
    ['base.checkbox', {}, 'input'],
    ['base.svg', { svg: '<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>' }, 'svg'],
  ] as const) {
    it(`${moduleId} emits authored attributes on its <${tag}>`, () => {
      const page = makePage({ root: { moduleId, props: { ...props, htmlAttributes } } })
      const html = render('root', realCtx(page))
      expect(html).toMatch(new RegExp(`^<${tag}\\b[^>]* aria-label="Custom label"`))
      expect(html).toMatch(new RegExp(`^<${tag}\\b[^>]* data-track="cta"`))
    })
  }

  it('base.svg keeps the sanitisation gate and the title label', () => {
    const page = makePage({
      root: {
        moduleId: 'base.svg',
        props: {
          svg: '<svg viewBox="0 0 10 10"></svg>',
          title: 'Logo',
          htmlAttributes: { onclick: 'alert(1)', 'data-x': '"><script>', style: 'color:red' },
        },
      },
    })
    const html = render('root', realCtx(page))
    expect(html).toBe('<svg role="img" aria-label="Logo" data-x="&quot;&gt;&lt;script&gt;" viewBox="0 0 10 10"></svg>')
  })
})
