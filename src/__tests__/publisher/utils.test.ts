/**
 * Tests for src/core/publisher/utils.ts — canonical escape / sanitisation utilities.
 *
 * These are the canonical implementations shared by:
 *   - publisher pipeline (render.ts, cssCollector.ts)
 *   - editor components (ClassStyleInjector.tsx)
 *   - base module helpers (modules/base/utils/escape.ts)
 *
 * Covers: escapeHtml, isSafeUrl, safeUrl, sanitiseCssValue
 *
 * The sanitiseCssValue tests are the core of this file — it is the canonical CSS
 * injection sanitiser (Constraint #228) and the single implementation that replaced
 * two divergent per-file copies (Task #296).
 */

import { describe, it, expect } from 'bun:test'
import { escapeHtml, isSafeUrl, safeUrl, sanitiseCssValue } from '@core/publisher'

// ===========================================================================
// escapeHtml
// ===========================================================================

describe('escapeHtml', () => {
  it('escapes & to &amp;', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  it('escapes < to &lt;', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
  })

  it('escapes > to &gt;', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b')
  })

  it('escapes " to &quot;', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;')
  })

  it("escapes ' to &#x27;", () => {
    expect(escapeHtml("it's")).toBe('it&#x27;s')
  })

  it('escapes all 5 characters at once', () => {
    const result = escapeHtml('& < > " \'')
    expect(result).toBe('&amp; &lt; &gt; &quot; &#x27;')
  })

  it('leaves safe characters untouched', () => {
    expect(escapeHtml('Hello, world!')).toBe('Hello, world!')
  })

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('')
  })

  it('handles number input (stringifies)', () => {
    expect(escapeHtml(42)).toBe('42')
  })

  it('handles null/undefined (stringifies to empty)', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
})

// ===========================================================================
// isSafeUrl
// ===========================================================================

describe('isSafeUrl', () => {
  it('accepts https: URLs', () => {
    expect(isSafeUrl('https://example.com/page')).toBe(true)
  })

  it('accepts http: URLs', () => {
    expect(isSafeUrl('http://example.com')).toBe(true)
  })

  it('accepts mailto: URLs', () => {
    expect(isSafeUrl('mailto:user@example.com')).toBe(true)
  })

  it('accepts relative paths', () => {
    expect(isSafeUrl('/about')).toBe(true)
    expect(isSafeUrl('./page.html')).toBe(true)
  })

  it('accepts empty string', () => {
    expect(isSafeUrl('')).toBe(true)
  })

  it('blocks javascript:', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
  })

  it('blocks JAVASCRIPT: (case insensitive)', () => {
    expect(isSafeUrl('JAVASCRIPT:alert(1)')).toBe(false)
  })

  it('blocks javascript: with whitespace escape', () => {
    expect(isSafeUrl('java\tscript:alert(1)')).toBe(false)
  })

  it('blocks vbscript:', () => {
    expect(isSafeUrl('vbscript:MsgBox(1)')).toBe(false)
  })

  it('blocks data: URIs', () => {
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeUrl('data:image/png;base64,abc')).toBe(false)
  })

  // GHSA-pqcp-872g-gmp8 — the old guard normalised with
  // `.replace(/[\t\n\r]/g, '').trim()`, which leaves U+0000–U+0008 and
  // U+000E–U+001F in place. The WHATWG URL parser strips the whole
  // U+0000–U+0020 range before reading a scheme, so 27 of 32 C0 code points
  // made isSafeUrl() return true while the browser resolved `javascript:`.
  it('blocks javascript: behind every C0 control prefix (GHSA-pqcp-872g-gmp8)', () => {
    const leaked: string[] = []
    for (let code = 0; code < 0x20; code++) {
      if (isSafeUrl(`${String.fromCharCode(code)}javascript:alert(1)`)) {
        leaked.push(`0x${code.toString(16).padStart(2, '0')}`)
      }
    }
    expect(leaked).toEqual([])
  })

  it('blocks vbscript: and data: behind a C0 control prefix', () => {
    expect(isSafeUrl('\u0001vbscript:MsgBox(1)')).toBe(false)
    expect(isSafeUrl('\u001Fdata:text/html,<script>alert(1)</script>')).toBe(false)
  })

  it('blocks mixed leading/trailing/embedded disguises', () => {
    expect(isSafeUrl('\u0001\u000Ejava\tscript:alert(1)\u0000')).toBe(false)
    expect(isSafeUrl(' \u0001 javascript:alert(1)')).toBe(false)
  })

  it('is an allowlist — non-web schemes collapse without any disguise', () => {
    expect(isSafeUrl('blob:https://example.com/8f1a')).toBe(false)
    expect(isSafeUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeUrl('ftp://example.com/x')).toBe(false)
    expect(isSafeUrl('intent://x#Intent;scheme=http;end')).toBe(false)
    expect(isSafeUrl('view-source:https://example.com/')).toBe(false)
  })

  it('keeps every legitimate URL shape the publisher must emit', () => {
    for (const url of [
      'https://example.com/a?b=1&c=2',
      'http://example.com',
      'mailto:user@example.com',
      'tel:+420123456789',
      'sms:+420123456789',
      '/about',
      './page.html',
      '../up.html',
      'page.html',
      'uploads/img.png',
      '#anchor',
      '?q=1',
      '//cdn.example.com/a.png',
      '',
    ]) {
      expect(isSafeUrl(url)).toBe(true)
    }
  })
})

// ===========================================================================
// safeUrl
// ===========================================================================

describe('safeUrl', () => {
  it('returns HTML-escaped safe URL', () => {
    expect(safeUrl('https://example.com?a=1&b=2')).toBe('https://example.com?a=1&amp;b=2')
  })

  it('returns # for javascript: URL', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('#')
  })

  it('returns # for data: URI', () => {
    expect(safeUrl('data:text/html,<b>hi</b>')).toBe('#')
  })

  it('handles null/undefined gracefully (coalesces to empty string, returns safe empty)', () => {
    // null and undefined coalesce to '' via `String(value ?? '')` — empty string is safe
    expect(safeUrl(null)).toBe('')
    expect(safeUrl(undefined)).toBe('')
    expect(() => safeUrl(null)).not.toThrow()
  })
})

// ===========================================================================
// sanitiseCssValue — canonical CSS injection sanitiser (Constraint #228)
// ===========================================================================

describe('sanitiseCssValue', () => {
  // -------------------------------------------------------------------------
  // Number passthrough
  // -------------------------------------------------------------------------

  it('returns numbers as strings — numbers cannot contain injection patterns', () => {
    expect(sanitiseCssValue(16)).toBe('16')
    expect(sanitiseCssValue(0)).toBe('0')
    expect(sanitiseCssValue(0.5)).toBe('0.5')
    expect(sanitiseCssValue(-10)).toBe('-10')
  })

  // -------------------------------------------------------------------------
  // Safe values pass through
  // -------------------------------------------------------------------------

  it('allows safe CSS dimension values', () => {
    expect(sanitiseCssValue('16px')).toBe('16px')
    expect(sanitiseCssValue('1.5rem')).toBe('1.5rem')
    expect(sanitiseCssValue('100%')).toBe('100%')
    expect(sanitiseCssValue('auto')).toBe('auto')
    expect(sanitiseCssValue('0')).toBe('0')
  })

  it('allows safe color values', () => {
    expect(sanitiseCssValue('#fff')).toBe('#fff')
    expect(sanitiseCssValue('#1a2b3c')).toBe('#1a2b3c')
    expect(sanitiseCssValue('rgb(255, 0, 0)')).toBe('rgb(255, 0, 0)')
    expect(sanitiseCssValue('rgba(0,0,0,0.5)')).toBe('rgba(0,0,0,0.5)')
    expect(sanitiseCssValue('hsl(120, 100%, 50%)')).toBe('hsl(120, 100%, 50%)')
  })

  it('allows safe font-family values', () => {
    expect(sanitiseCssValue('sans-serif')).toBe('sans-serif')
    expect(sanitiseCssValue('"Inter", sans-serif')).toBe('"Inter", sans-serif')
    expect(sanitiseCssValue("'Roboto Mono', monospace")).toBe("'Roboto Mono', monospace")
  })

  it('allows flex / grid values', () => {
    expect(sanitiseCssValue('flex')).toBe('flex')
    expect(sanitiseCssValue('1 1 auto')).toBe('1 1 auto')
    expect(sanitiseCssValue('repeat(3, 1fr)')).toBe('repeat(3, 1fr)')
  })

  it('allows transform values', () => {
    expect(sanitiseCssValue('translateX(10px)')).toBe('translateX(10px)')
    expect(sanitiseCssValue('rotate(45deg) scale(1.5)')).toBe('rotate(45deg) scale(1.5)')
  })

  it('allows url() with safe https images', () => {
    expect(sanitiseCssValue('url("https://cdn.example.com/img.png")')).toBe(
      'url("https://cdn.example.com/img.png")'
    )
  })

  it('allows data:image/ URIs in url() — safe for background-image', () => {
    // Only data:TEXT is blocked; data:image is a legitimate background-image value
    const val = 'url("data:image/png;base64,iVBORw0KGgo=")'
    expect(sanitiseCssValue(val)).toBe(val)
  })

  it('trims leading/trailing whitespace', () => {
    expect(sanitiseCssValue('  16px  ')).toBe('16px')
    expect(sanitiseCssValue('\t1.5rem\n')).toBe('1.5rem')
  })

  // -------------------------------------------------------------------------
  // expression() — IE CSS expression execution (CWE-79)
  // -------------------------------------------------------------------------

  it('blocks expression() — IE CSS expression injection', () => {
    expect(sanitiseCssValue('expression(alert(1))')).toBeNull()
  })

  it('blocks expression() with internal whitespace', () => {
    expect(sanitiseCssValue('expression ( alert(1) )')).toBeNull()
  })

  it('blocks EXPRESSION() (case insensitive)', () => {
    expect(sanitiseCssValue('EXPRESSION(document.cookie)')).toBeNull()
  })

  it('blocks expression() embedded in a longer value', () => {
    expect(sanitiseCssValue('red expression(1)')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // javascript: — invalid in CSS but historically exploited
  // -------------------------------------------------------------------------

  it('blocks javascript: in CSS values', () => {
    expect(sanitiseCssValue('javascript:alert(1)')).toBeNull()
  })

  it('blocks JAVASCRIPT: (case insensitive)', () => {
    expect(sanitiseCssValue('JAVASCRIPT:void(0)')).toBeNull()
  })

  it('blocks javascript: with whitespace', () => {
    expect(sanitiseCssValue('javascript : alert(1)')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // behavior: — IE proprietary CSS code execution
  // -------------------------------------------------------------------------

  it('blocks behavior: IE extension', () => {
    expect(sanitiseCssValue('behavior: url(evil.htc)')).toBeNull()
  })

  it('blocks BEHAVIOR: (case insensitive)', () => {
    expect(sanitiseCssValue('BEHAVIOR:url(x.htc)')).toBeNull()
  })

  it('blocks behavior: with whitespace', () => {
    expect(sanitiseCssValue('behavior : url(evil.htc)')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // -moz-binding — Gecko XBL binding execution
  // -------------------------------------------------------------------------

  it('blocks -moz-binding', () => {
    expect(sanitiseCssValue('-moz-binding:url("evil.xml#hack")')).toBeNull()
  })

  it('blocks -MOZ-BINDING (case insensitive)', () => {
    expect(sanitiseCssValue('-MOZ-BINDING:url("x.xml")')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // data:text/ — data URI loading HTML content
  // -------------------------------------------------------------------------

  it('blocks data:text/html in url() context', () => {
    expect(sanitiseCssValue('url(data:text/html,<b>x</b>)')).toBeNull()
  })

  it('blocks data:text/ with whitespace', () => {
    expect(sanitiseCssValue('data : text/plain,hello')).toBeNull()
  })

  it('blocks DATA:TEXT (case insensitive)', () => {
    expect(sanitiseCssValue('DATA:TEXT/HTML,<script>x</script>')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // {} — premature selector block close (CWE-74 / Contribution #407)
  // This was the pattern MISSING from escape.ts before Task #296 consolidation.
  // -------------------------------------------------------------------------

  it('blocks } — closes surrounding class selector block', () => {
    // "red; } a { color: blue" would inject rogue CSS rules without this check
    expect(sanitiseCssValue('red; } a { color: blue')).toBeNull()
  })

  it('blocks { alone', () => {
    expect(sanitiseCssValue('red{')).toBeNull()
  })

  it('blocks } alone', () => {
    expect(sanitiseCssValue('}')).toBeNull()
  })

  it('blocks { and } together', () => {
    expect(sanitiseCssValue('{color:red}')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // </ — close-tag-open bigram (defence-in-depth against HTML5 RAWTEXT escape).
  // Pairs with the block-level neutraliser in `sanitizeModuleCSS` so a CSS
  // value carrying `</style/>` (and the slash-terminator variants the HTML
  // tokenizer accepts) cannot break out of the inline `<style>` block.
  // -------------------------------------------------------------------------

  it('blocks </style> in url() — direct close-tag-open', () => {
    expect(sanitiseCssValue('url("</style><script>alert(1)</script>")')).toBeNull()
  })

  it('blocks </style/> — HTML5 RAWTEXT slash terminator', () => {
    expect(sanitiseCssValue('url("</style/><img src=x>")')).toBeNull()
  })

  it('blocks </ in any value position', () => {
    expect(sanitiseCssValue('red </b> blue')).toBeNull()
  })

  it('allows < without following / (does not over-block)', () => {
    // `<` alone is unusual in CSS but not the close-tag-open bigram.
    expect(sanitiseCssValue('counter(num, "<>")')).toBe('counter(num, "<>")')
  })

  it('allows / on its own (paths in URLs are unaffected)', () => {
    expect(sanitiseCssValue('url("/assets/img.png")')).toBe('url("/assets/img.png")')
    expect(sanitiseCssValue('url("https://cdn.example.com/a/b/c.svg")')).toBe(
      'url("https://cdn.example.com/a/b/c.svg")',
    )
  })

  // -------------------------------------------------------------------------
  // Empty / edge cases
  // -------------------------------------------------------------------------

  it('returns empty string for empty string input', () => {
    expect(sanitiseCssValue('')).toBe('')
  })

  it('handles whitespace-only string', () => {
    expect(sanitiseCssValue('   ')).toBe('')
  })
})

// ===========================================================================
// Canonical import verification — both consumers use the same function
// ===========================================================================

describe('canonical sanitiseCssValue — import verification', () => {
  // Verify escape.ts re-exports the SAME function (not a local reimplementation)
  it('escape.ts re-exports the same sanitiseCssValue as utils.ts', async () => {
    const utils = await import('@core/publisher')
    const escape = await import('@modules/base/utils/escape')
    // Same function reference means escape.ts doesn't have its own copy
    expect(escape.sanitiseCssValue).toBe(utils.sanitiseCssValue)
  })

  it('buildStyle in escape.ts now blocks {} (was missing before Task #296)', () => {
    // This test catches the regression that prompted Task #296:
    // escape.ts's sanitiseCssValue did NOT block {} before consolidation
    const { buildStyle } = require('@modules/base/utils/escape')
    // A CSS value with } would previously pass through escape.ts but was blocked
    // by ClassStyleInjector.sanitiseValue — they were inconsistent.
    // After consolidation, both use the same canonical function → {} is blocked.
    const result = buildStyle({ color: 'red; } a { color: blue' })
    expect(result).toBe('')  // dangerous value is dropped; empty output
  })
})
