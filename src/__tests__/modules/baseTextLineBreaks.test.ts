/**
 * base.text hard line breaks + the shared inline-text helpers.
 *
 * The stored value keeps newlines as `\n`; both render surfaces turn each `\n`
 * into a `<br>` so a hard break shows live in the canvas AND survives publish
 * (DOMPurify's richtext config allows `<br>`). These tests cover:
 *   - base.text `render()` emits `<br>` for a `\n` and is otherwise unchanged;
 *   - the two text→HTML helpers (publisher path pre-escaped, canvas path raw);
 *   - `readInlineEditableText` reads `innerText` back out of a DOM element;
 *   - the published `<br>` survives the publisher-boundary sanitizer.
 */
import { describe, it, expect } from 'bun:test'
import { TextModule } from '@modules/base/text'
import {
  textToBreakHtml,
  rawTextToBreakHtml,
  readInlineEditableText,
} from '@modules/base/shared/inlineText'
import { sanitizeRichtext } from '@core/sanitize'

describe('base.text render — newlines become <br>', () => {
  it('turns a single \\n into <br> inside the semantic tag', () => {
    const { html } = TextModule.render({ text: 'A\nB', tag: 'h1', htmlAttributes: {} }, [])
    expect(html).toBe('<h1>A<br>B</h1>')
  })

  it('leaves a value with no newline unchanged', () => {
    const { html } = TextModule.render({ text: 'Plain text', tag: 'p', htmlAttributes: {} }, [])
    expect(html).toBe('<p>Plain text</p>')
  })

  it('turns multiple newlines into multiple <br>s', () => {
    const { html } = TextModule.render({ text: 'A\nB\nC', tag: 'p', htmlAttributes: {} }, [])
    expect(html).toBe('<p>A<br>B<br>C</p>')
  })
})

describe('inline-text helpers', () => {
  it('textToBreakHtml inserts <br> on an already-escaped string (publisher path)', () => {
    expect(textToBreakHtml('a\nb')).toBe('a<br>b')
    // The publisher pre-escapes, so this helper must NOT escape again.
    expect(textToBreakHtml('&lt;x&gt;\ny')).toBe('&lt;x&gt;<br>y')
  })

  it('rawTextToBreakHtml escapes FIRST, then breaks (canvas path — no XSS)', () => {
    expect(rawTextToBreakHtml('<x>\ny')).toBe('&lt;x&gt;<br>y')
    // A would-be injection is neutralised before any <br> is inserted.
    expect(rawTextToBreakHtml('<script>\nalert(1)')).toBe('&lt;script&gt;<br>alert(1)')
  })

  it('readInlineEditableText returns the element innerText', () => {
    const el = document.createElement('div')
    el.textContent = 'Hello World'
    expect(readInlineEditableText(el)).toBe('Hello World')
    // It is exactly `el.innerText` — the contract is "read what the element
    // shows" (in a real browser `<br>` / block boundaries resolve to `\n`;
    // happy-dom's innerText doesn't model that, so assert the identity here).
    el.textContent = 'Line one'
    expect(readInlineEditableText(el)).toBe(el.innerText)
  })
})

describe('publisher path end-to-end — the <br> survives the sanitizer', () => {
  it('a hard break in base.text output is preserved through sanitizeRichtext', () => {
    const { html } = TextModule.render({ text: 'A\nB', tag: 'p', htmlAttributes: {} }, [])
    expect(html).toContain('<br>')
    // sanitizeRichtext is the publisher-boundary richtext sanitizer; <br> is in
    // its ALLOWED_TAGS, so the author's hard break reaches the published page.
    const sanitized = sanitizeRichtext(html)
    expect(sanitized).toContain('<br>')
    expect(sanitized).toContain('A')
    expect(sanitized).toContain('B')
  })
})
