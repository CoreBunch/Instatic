/**
 * Security regression tests: URL-scheme guard bypass via control characters
 * (GHSA-pqcp-872g-gmp8).
 *
 * `isSafeUrl()` normalised with `url.replace(/[\t\n\r]/g, '').trim()` and then
 * prefix-matched a three-entry denylist. `String.prototype.trim()` does not
 * strip U+0000–U+0008 or U+000E–U+001F, but the WHATWG URL parser strips the
 * whole U+0000–U+0020 range before reading a scheme — so 27 of 32 C0 code
 * points produced `isSafeUrl(v) === true` while `new URL(v).protocol` was
 * `javascript:`. `escapeHtml()` escapes only & < > " ', so the raw control byte
 * survived into the emitted attribute.
 *
 * The guard is now an allowlist over a scheme read with the WHATWG stripping
 * rules, plus a dangerous-scheme predicate for free-text attribute values.
 * These tests are the differential gate: whatever a browser's URL parser
 * resolves to a dangerous scheme, the guard must reject.
 *
 * Deliberately covers all three implementations that existed at report time —
 * the core guard, the custom-htmlAttributes gate, and the plugin-SDK helper —
 * so a future change cannot repair one and leave the others open.
 */

import { describe, it, expect } from 'bun:test'
import { escapeHtml, hasDangerousUrlScheme, isSafeUrl, safeUrl } from '@core/html-sanitize'
import { sanitizeRenderableHtmlAttribute } from '@core/htmlAttributes'
import { safeUrl as sdkSafeUrl } from '@core/plugin-sdk'

const PARSE_BASE = 'https://instatic.invalid/'
const DANGEROUS_SCHEMES = new Set(['javascript:', 'vbscript:', 'data:'])

function browserScheme(value: string): string | null {
  try {
    return new URL(value, PARSE_BASE).protocol
  } catch {
    return null
  }
}

/** Every C0 code point and space, every dangerous scheme, prefix and suffix. */
function bypassCorpus(): string[] {
  const payloads = [
    'javascript:alert(1)',
    'vbscript:MsgBox(1)',
    'data:text/html,<script>alert(1)</script>',
  ]
  const out: string[] = []
  for (const payload of payloads) {
    out.push(payload, payload.toUpperCase())
    for (let code = 0; code <= 0x20; code++) {
      const ch = String.fromCharCode(code)
      out.push(ch + payload, ch + ch + payload, ch + payload + ch)
    }
  }
  return out
}

describe('isSafeUrl agrees with the WHATWG URL parser (differential)', () => {
  it('never accepts a value the URL parser resolves to a dangerous scheme', () => {
    const leaked: string[] = []
    for (const value of bypassCorpus()) {
      const scheme = browserScheme(value)
      if (scheme !== null && DANGEROUS_SCHEMES.has(scheme) && isSafeUrl(value)) {
        leaked.push(JSON.stringify(value))
      }
    }
    expect(leaked).toEqual([])
  })

  it('collapses every disguised payload to "#" in safeUrl', () => {
    const leaked = bypassCorpus().filter((value) => safeUrl(value) !== '#')
    expect(leaked).toEqual([])
  })
})

describe('escapeHtml does not neutralise control characters — the guard must', () => {
  it('passes C0 bytes through untouched (documents why the guard is load-bearing)', () => {
    expect(escapeHtml('\u0001javascript:alert(1)')).toBe('\u0001javascript:alert(1)')
  })
})

describe('custom-htmlAttributes gate — the single shared value check', () => {
  it('drops attributes carrying a control-disguised dangerous scheme', () => {
    for (const name of ['href', 'src', 'formaction', 'xlink:href', 'ping', 'action', 'poster']) {
      expect(sanitizeRenderableHtmlAttribute(name, '\u0001javascript:alert(1)')).toBeNull()
      expect(
        sanitizeRenderableHtmlAttribute(name, '\u001Fdata:text/html,<script>alert(1)</script>'),
      ).toBeNull()
    }
  })

  it('keeps ordinary prose that happens to contain a colon', () => {
    // `Notes: draft` parses as scheme `notes:` — not dangerous, must survive.
    expect(sanitizeRenderableHtmlAttribute('title', 'Notes: draft')).toBe('Notes: draft')
    expect(sanitizeRenderableHtmlAttribute('viewBox', '0 0 24 24')).toBe('0 0 24 24')
    expect(sanitizeRenderableHtmlAttribute('aria-label', 'Chapter 3: the end')).toBe(
      'Chapter 3: the end',
    )
    expect(sanitizeRenderableHtmlAttribute('href', '/about')).toBe('/about')
  })

  it('hasDangerousUrlScheme is the predicate behind that split', () => {
    expect(hasDangerousUrlScheme('\u0001javascript:alert(1)')).toBe(true)
    expect(hasDangerousUrlScheme('Notes: draft')).toBe(false)
    expect(hasDangerousUrlScheme('blob:https://example.com/x')).toBe(false)
  })
})

describe('plugin-SDK safeUrl is the shared guard, not a weaker copy', () => {
  it('blocks the payloads the standalone SDK denylist used to pass', () => {
    for (const value of [
      ' javascript:alert(1)',
      '\tjavascript:alert(1)',
      '\njavascript:alert(1)',
      'java\tscript:alert(1)',
      '\u0001javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      expect(sdkSafeUrl(value)).toBe('#')
    }
  })

  it('does not HTML-escape — the `html` tag escapes interpolations already', () => {
    expect(sdkSafeUrl('https://example.com/?a=1&b=2')).toBe('https://example.com/?a=1&b=2')
  })
})
