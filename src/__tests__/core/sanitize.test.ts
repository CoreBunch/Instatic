/**
 * Tests for src/core/sanitize.ts — DOMPurify richtext sanitization
 *
 * Verifies that sanitizeRichtext() correctly strips malicious HTML while
 * preserving safe formatting markup.
 *
 * These tests confirm the trust boundary enforced at the Properties Panel
 * (Task #261 / Security Auditor Contribution #368). The publisher's
 * escapeProps() passes richtext props through unescaped — this utility is
 * the sole sanitization point before values reach the publisher.
 *
 * @see src/core/sanitize.ts
 * @see src/core/publisher/render.ts — escapeProps() richtext passthrough
 * @see Task #261 — Enforce DOMPurify at Properties Panel boundary
 */

import { describe, it, expect } from 'bun:test'
import { sanitizeRichtext, sanitizePostBody, isRichtextPropKey, PLAIN_TEXT_CONFIG } from '@core/sanitize'

// ---------------------------------------------------------------------------
// XSS prevention — the core contract
// ---------------------------------------------------------------------------

describe('sanitizeRichtext() — XSS prevention', () => {
  it('strips <script> tags entirely', () => {
    const result = sanitizeRichtext('<script>alert(1)</script>')
    expect(result).not.toContain('<script>')
    expect(result).not.toContain('alert(1)')
  })

  it('strips onclick and other event handler attributes', () => {
    const result = sanitizeRichtext('<p onclick="alert(1)">Click me</p>')
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('alert(1)')
    // The text content is preserved
    expect(result).toContain('Click me')
  })

  it('strips onerror attribute on img tags', () => {
    const result = sanitizeRichtext('<img src=x onerror=alert(1)>')
    expect(result).not.toContain('onerror')
    expect(result).not.toContain('alert(1)')
  })

  it('strips javascript: href on anchor tags', () => {
    const result = sanitizeRichtext('<a href="javascript:alert(1)">Click</a>')
    expect(result).not.toContain('javascript:')
    // Anchor element itself may be preserved with href removed or sanitized
    expect(result).toContain('Click')
  })

  it('strips data: href on anchor tags', () => {
    const result = sanitizeRichtext('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    expect(result).not.toContain('data:text/html')
    expect(result).toContain('x')
  })

  it('strips <iframe> elements', () => {
    const result = sanitizeRichtext('<iframe src="https://evil.com"></iframe>')
    expect(result).not.toContain('<iframe')
    expect(result).not.toContain('evil.com')
  })

  it('strips <object> and <embed> elements', () => {
    expect(sanitizeRichtext('<object data="evil.swf"></object>')).not.toContain('<object')
    expect(sanitizeRichtext('<embed src="evil.swf">')).not.toContain('<embed')
  })

  it('strips <form> elements (prevents CSRF via richtext)', () => {
    const result = sanitizeRichtext('<form action="https://evil.com/steal"><input name="data"><button>Submit</button></form>')
    expect(result).not.toContain('<form')
    expect(result).not.toContain('evil.com')
  })

  it('strips SVG with onload handler', () => {
    const result = sanitizeRichtext('<svg onload="alert(1)"><circle r="10"/></svg>')
    expect(result).not.toContain('onload')
    expect(result).not.toContain('alert(1)')
  })

  it('strips <style> tags (prevents CSS injection)', () => {
    const result = sanitizeRichtext('<style>body { background: url(javascript:alert(1)) }</style>')
    expect(result).not.toContain('<style>')
    expect(result).not.toContain('javascript:')
  })
})

// ---------------------------------------------------------------------------
// Safe markup preservation — what SHOULD survive
// ---------------------------------------------------------------------------

describe('sanitizeRichtext() — safe markup preservation', () => {
  it('preserves plain text unchanged', () => {
    const result = sanitizeRichtext('Hello, World!')
    expect(result).toBe('Hello, World!')
  })

  it('preserves <strong> and <em> formatting tags', () => {
    const result = sanitizeRichtext('<strong>Bold</strong> and <em>italic</em>')
    expect(result).toContain('<strong>Bold</strong>')
    expect(result).toContain('<em>italic</em>')
  })

  it('preserves <p> tags', () => {
    const result = sanitizeRichtext('<p>First paragraph</p><p>Second paragraph</p>')
    expect(result).toContain('<p>First paragraph</p>')
    expect(result).toContain('<p>Second paragraph</p>')
  })

  it('preserves <ul>/<ol>/<li> list elements', () => {
    const result = sanitizeRichtext('<ul><li>Item 1</li><li>Item 2</li></ul>')
    expect(result).toContain('<ul>')
    expect(result).toContain('<li>Item 1</li>')
    expect(result).toContain('<li>Item 2</li>')
  })

  it('preserves <a> href with safe HTTPS URL', () => {
    const result = sanitizeRichtext('<a href="https://example.com">Link</a>')
    expect(result).toContain('href="https://example.com"')
    expect(result).toContain('Link')
  })

  it('adds rel="noopener noreferrer" and target="_blank" to all links', () => {
    const result = sanitizeRichtext('<a href="https://example.com">Link</a>')
    expect(result).toContain('rel="noopener noreferrer"')
    expect(result).toContain('target="_blank"')
  })

  it('preserves <br> line breaks', () => {
    const result = sanitizeRichtext('Line 1<br>Line 2')
    expect(result).toContain('<br>')
    expect(result).toContain('Line 1')
    expect(result).toContain('Line 2')
  })

  it('preserves <h1>–<h3> headings', () => {
    const result = sanitizeRichtext('<h1>Title</h1><h2>Subtitle</h2>')
    expect(result).toContain('<h1>Title</h1>')
    expect(result).toContain('<h2>Subtitle</h2>')
  })

  it('handles empty string gracefully', () => {
    expect(sanitizeRichtext('')).toBe('')
    expect(sanitizeRichtext(null)).toBe('')
    expect(sanitizeRichtext(undefined)).toBe('')
  })

  it('handles non-string values by stringifying them', () => {
    // Numbers should become their string representation
    expect(sanitizeRichtext(42)).toBe('42')
  })
})

// ---------------------------------------------------------------------------
// PLAIN_TEXT_CONFIG — for meta/title fields
// ---------------------------------------------------------------------------

describe('sanitizeRichtext() with PLAIN_TEXT_CONFIG', () => {
  it('strips ALL HTML tags, returning plain text only', () => {
    const result = sanitizeRichtext('<strong>Hello</strong> <em>World</em>', PLAIN_TEXT_CONFIG)
    expect(result).not.toContain('<strong>')
    expect(result).not.toContain('<em>')
    expect(result).toContain('Hello')
    expect(result).toContain('World')
  })

  it('strips XSS payloads in plain-text mode', () => {
    const result = sanitizeRichtext('<script>alert(1)</script> innocent text', PLAIN_TEXT_CONFIG)
    expect(result).not.toContain('<script>')
    expect(result).not.toContain('alert(1)')
    expect(result).toContain('innocent text')
  })
})

describe('sanitizeRichtext() in server runtime', () => {
  it('imports without DOM globals and removes executable content', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `
          const { sanitizeRichtext } = await import('./src/core/sanitize.ts')
          const sanitized = sanitizeRichtext('<script>alert(1)</script><p>Safe</p>')
          if (sanitized.includes('<script') || sanitized.includes('alert(1)')) {
            throw new Error('unsafe fallback: ' + sanitized)
          }
          if (!sanitized.includes('Safe')) {
            throw new Error('lost safe text: ' + sanitized)
          }
        `,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr)
      throw new Error(stderr)
    }
  })

  it('preserves safe richtext through the explicit server sanitizer without DOM globals', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `
          await import('./server/richtextSanitizer.ts')
          if ('window' in globalThis || 'document' in globalThis) {
            throw new Error('server sanitizer installed DOM globals')
          }
          const { sanitizeRichtext } = await import('./src/core/sanitize.ts')
          const sanitized = sanitizeRichtext('<p><strong>Safe</strong> <a href="https://example.com">Link</a></p>')
          if (!sanitized.includes('<strong>Safe</strong>')) {
            throw new Error('lost richtext formatting: ' + sanitized)
          }
          if (!sanitized.includes('rel="noopener noreferrer"')) {
            throw new Error('lost safe link attributes: ' + sanitized)
          }
        `,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr)
      throw new Error(stderr)
    }
  })
})

// ---------------------------------------------------------------------------
// sanitizePostBody() — 2026-08-13 blog round-2 fix. Post/page body content
// (base.outlet's markdown-rendered html) needs a wider allowlist than
// sanitizeRichtext(), including iframe embeds scoped to a trusted-host
// allowlist. See @core/sanitize POST_BODY_CONFIG.
// ---------------------------------------------------------------------------

describe('sanitizePostBody() — trusted-host iframe embeds', () => {
  it('keeps an iframe embed from youtube.com', () => {
    const result = sanitizePostBody(
      '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315" allowfullscreen></iframe>',
    )
    expect(result).toContain('<iframe')
    expect(result).toContain('youtube.com/embed/dQw4w9WgXcQ')
  })

  it('keeps an iframe embed from youtube-nocookie.com', () => {
    const result = sanitizePostBody(
      '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>',
    )
    expect(result).toContain('<iframe')
    expect(result).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ')
  })

  it('keeps a bare (non-www) youtube.com host', () => {
    const result = sanitizePostBody('<iframe src="https://youtube.com/embed/dQw4w9WgXcQ"></iframe>')
    expect(result).toContain('<iframe')
  })

  it('strips an iframe embed from an untrusted host entirely (not just the src)', () => {
    const result = sanitizePostBody('<iframe src="https://evil.com/phish"></iframe>')
    expect(result).not.toContain('<iframe')
    expect(result).not.toContain('evil.com')
  })

  it('strips an iframe with no src at all', () => {
    const result = sanitizePostBody('<iframe></iframe>')
    expect(result).not.toContain('<iframe')
  })

  it('strips a lookalike host that merely contains "youtube.com" (not a real subdomain)', () => {
    // e.g. "youtube.com.evil.com" or "evilyoutube.com" must NOT pass a naive
    // substring check — isTrustedIframeHost requires exact match or a
    // genuine `.` + trusted-host suffix.
    const lookalikes = [
      'https://youtube.com.evil.com/embed/x',
      'https://evilyoutube.com/embed/x',
      'https://notyoutube.com/embed/x',
    ]
    for (const src of lookalikes) {
      const result = sanitizePostBody(`<iframe src="${src}"></iframe>`)
      expect(result).not.toContain('<iframe')
    }
  })

  it('strips javascript: and data: iframe src', () => {
    expect(sanitizePostBody('<iframe src="javascript:alert(1)"></iframe>')).not.toContain('<iframe')
    expect(sanitizePostBody('<iframe src="data:text/html,<script>alert(1)</script>"></iframe>')).not.toContain('<iframe')
  })

  it('still strips <script> tags and event-handler attributes (iframe allowlisting is not a blanket HTML-open)', () => {
    const result = sanitizePostBody('<p onclick="alert(1)">hi</p><script>alert(2)</script>')
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('<script')
    expect(result).not.toContain('alert')
    expect(result).toContain('hi')
  })

  it('preserves images, tables, and video — the elements a real post body needs that plain richtext strips', () => {
    const result = sanitizePostBody(
      '<img src="https://example.com/a.png" alt="a"><table><tbody><tr><td>x</td></tr></tbody></table><video controls src="https://example.com/v.mp4"></video>',
    )
    expect(result).toContain('<img')
    expect(result).toContain('<table')
    expect(result).toContain('<video')
  })

  it('preserves a <video poster> with a <source> child — the form real editors/importers emit', () => {
    // A bare `<video src=…>` is the exception, not the rule: most editors
    // (Webflow among them) emit `<video controls poster=…><source src=…
    // type=…></video>` and rely on <source> to carry the actual playable
    // file. Before `source`/`poster`/`type` were allowlisted this published
    // as an empty, unplayable `<video controls>`.
    const result = sanitizePostBody(
      '<video controls poster="https://example.com/thumb.avif"><source src="https://example.com/clip.mp4" type="video/mp4"></video>',
    )
    expect(result).toContain('<video')
    expect(result).toContain('poster="https://example.com/thumb.avif"')
    expect(result).toContain('<source')
    expect(result).toContain('src="https://example.com/clip.mp4"')
    expect(result).toContain('type="video/mp4"')
  })

  it('preserves playsinline, loop, muted, and preload on <video>', () => {
    const result = sanitizePostBody(
      '<video controls playsinline loop muted preload="auto" src="https://example.com/v.mp4"></video>',
    )
    expect(result).toContain('playsinline')
    expect(result).toContain('loop')
    expect(result).toContain('muted')
    expect(result).toContain('preload="auto"')
  })

  it('preserves figure/figcaption — the wrapper rich-text editors put around images', () => {
    const result = sanitizePostBody(
      '<figure><img src="https://example.com/a.png" alt="a"><figcaption>A caption</figcaption></figure>',
    )
    expect(result).toContain('<figure')
    expect(result).toContain('<figcaption')
    expect(result).toContain('A caption')
  })

  it('preserves the same safe formatting tags sanitizeRichtext does', () => {
    const result = sanitizePostBody('<p><strong>Bold</strong> <em>italic</em> <a href="https://example.com">link</a></p>')
    expect(result).toContain('<strong>Bold</strong>')
    expect(result).toContain('<em>italic</em>')
    expect(result).toContain('rel="noopener noreferrer"')
  })

  it('plain sanitizeRichtext() (used by every OTHER richtext field) still strips iframe — confirms the wider allowlist is scoped to post-body only', () => {
    const result = sanitizeRichtext('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>')
    expect(result).not.toContain('<iframe')
  })
})

// ---------------------------------------------------------------------------
// isRichtextPropKey — prop key detection
// ---------------------------------------------------------------------------

describe('isRichtextPropKey()', () => {
  it('returns true for "richtext"', () => {
    expect(isRichtextPropKey('richtext')).toBe(true)
  })

  it('returns true for "html"', () => {
    expect(isRichtextPropKey('html')).toBe(true)
  })

  it('returns true for keys ending in "html" (e.g. "bodyHtml")', () => {
    expect(isRichtextPropKey('bodyHtml')).toBe(true)
    expect(isRichtextPropKey('descriptionHtml')).toBe(true)
  })

  it('returns true for keys ending in "richtext" (e.g. "contentRichtext")', () => {
    expect(isRichtextPropKey('contentRichtext')).toBe(true)
  })

  it('returns false for plain string prop keys', () => {
    expect(isRichtextPropKey('text')).toBe(false)
    expect(isRichtextPropKey('label')).toBe(false)
    expect(isRichtextPropKey('href')).toBe(false)
    expect(isRichtextPropKey('color')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isRichtextPropKey('HTML')).toBe(true)
    expect(isRichtextPropKey('RichText')).toBe(true)
  })
})
