import { describe, expect, it } from 'bun:test'
import { MARKDOWN_DOCUMENT_CONFIG, sanitizeRichtext, type SanitizerConfig } from '@core/sanitize'
import { renderReadmeHtml } from '@site/panels/DependenciesPanel/readmeHtml'

describe('MARKDOWN_DOCUMENT_CONFIG (package README rendering)', () => {
  it('keeps README structure: images, tables, rules, details', () => {
    const html = sanitizeRichtext(
      '<h1>Pkg</h1><p><img src="https://img.shields.io/npm/v/pkg.svg" alt="npm"></p>' +
        '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table><hr>' +
        '<details open><summary>More</summary><p>text</p></details>',
      MARKDOWN_DOCUMENT_CONFIG,
    )
    expect(html).toContain('<img')
    expect(html).toContain('src="https://img.shields.io/npm/v/pkg.svg"')
    expect(html).toContain('<table>')
    expect(html).toContain('<hr>')
    expect(html).toContain('<details open')
  })

  it('strips form controls, scripts, handlers and non-http URLs', () => {
    const html = sanitizeRichtext(
      '<input type="password" name="pw"><input type="file"><input type="checkbox" checked>' +
        '<img src="data:image/png;base64,AAAA" alt="inline"><img src="/relative.png">' +
        '<a href="javascript:alert(1)">x</a><img src="https://x.dev/a.png" onerror="alert(1)">' +
        '<script>alert(1)</script><form action="https://evil.example"><button>go</button></form>',
      MARKDOWN_DOCUMENT_CONFIG,
    )
    expect(html).not.toContain('<input')
    expect(html).not.toContain('data:image')
    expect(html).not.toContain('/relative.png')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<button')
    expect(html).toContain('src="https://x.dev/a.png"')
  })

  it('stamps images with no-referrer and lazy loading and links with noopener', () => {
    const html = sanitizeRichtext(
      '<p><a href="https://example.com/docs">docs</a> <img src="https://example.com/px.gif"></p>',
      MARKDOWN_DOCUMENT_CONFIG,
    )
    expect(html).toContain('referrerpolicy="no-referrer"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('target="_blank"')
  })

  it('keeps the non-URI attributes the profile allows despite the strict URI regexp', () => {
    const html = sanitizeRichtext(
      '<p align="center"><img src="https://x.dev/logo.png" width="300" height="80" alt="logo"></p>' +
        '<table><tr><td align="center" width="50%">c</td></tr></table>',
      MARKDOWN_DOCUMENT_CONFIG,
    )
    expect(html).toContain('width="300"')
    expect(html).toContain('height="80"')
    expect(html).toContain('align="center"')
    expect(html).toContain('width="50%"')
  })

  it('applies the external-images policy only to profiles that opt in', () => {
    const permissive: SanitizerConfig = Object.fromEntries(
      Object.entries(MARKDOWN_DOCUMENT_CONFIG).filter(([key]) => key !== 'ALLOWED_URI_REGEXP' && key !== '_externalImagesOnly'),
    )
    const html = sanitizeRichtext('<img src="/uploads/a.png" alt="site image">', permissive)
    expect(html).toContain('src="/uploads/a.png"')
    expect(html).not.toContain('referrerpolicy')
  })

  it('renders GFM markdown through the same sanitizer', () => {
    const html = renderReadmeHtml('# Title\n\n[![npm](https://img.shields.io/x.svg)](https://npmjs.com/x)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<input type="text">')
    expect(html).toContain('<h1')
    expect(html).toContain('<img')
    expect(html).toContain('<table>')
    expect(html).not.toContain('<input')
  })
})
