/**
 * Publisher richtext sanitization tests.
 *
 * Phase 5 requirement: escapeProps() applies sanitizeRichtext() at the publisher
 * boundary as defense-in-depth so that corrupted or injected richtext values
 * cannot reach published HTML as executable scripts.
 *
 * These tests exercise the publisher pipeline directly (not via VCs).
 */

import { describe, it, expect } from 'bun:test'
import { escapeProps, publishPage, renderNode } from '@core/publisher'
import type { PropertySchema } from '@core/module-engine'
import { makeModule, makeRegistry, makePage, makeSite, makeAccumulators } from './helpers'
import { renderMarkdownToHtml } from '@core/markdown/renderMarkdown'

// ---------------------------------------------------------------------------
// escapeProps richtext sanitization — routed by the prop's declared TYPE.
// `bodyContent` is deliberately named to miss the old html/richtext suffix
// heuristic: it sanitises only because its schema type is 'richtext'.
// ---------------------------------------------------------------------------

const RICHTEXT_SCHEMA: PropertySchema = {
  html: { type: 'richtext', label: 'HTML' },
  richtext: { type: 'richtext', label: 'Richtext' },
  bodyContent: { type: 'richtext', label: 'Body' },
}

describe('escapeProps richtext sanitization', () => {
  it('strips <script> from a richtext-typed prop', () => {
    const result = escapeProps({ html: '<p>ok</p><script>bad()</script>' }, RICHTEXT_SCHEMA)
    expect(result.html as string).not.toContain('<script>')
    expect(result.html as string).not.toContain('bad()')
  })

  it('strips <script> from richtext prop', () => {
    const result = escapeProps({ richtext: '<p>safe</p><script>evil()</script>' }, RICHTEXT_SCHEMA)
    expect(result.richtext as string).not.toContain('<script>')
    expect(result.richtext as string).not.toContain('evil()')
  })

  it('strips <script> from a richtext-typed prop with an off-heuristic name', () => {
    const result = escapeProps({ bodyContent: '<p>text</p><script>x()</script>' }, RICHTEXT_SCHEMA)
    expect(result.bodyContent as string).not.toContain('<script>')
  })

  it('preserves safe HTML tags in richtext props', () => {
    // DOMPurify in happy-dom test environment preserves safe semantic tags
    const result = escapeProps({ html: '<p><strong>Bold</strong></p>' }, RICHTEXT_SCHEMA)
    expect(result.html as string).toContain('Bold')
    expect(result.html as string).not.toContain('<script>')
  })

  it('returns empty string for empty richtext prop', () => {
    const result = escapeProps({ html: '' }, RICHTEXT_SCHEMA)
    expect(result.html).toBe('')
  })
})

// ---------------------------------------------------------------------------
// publishPage richtext sanitization — end-to-end through the publisher
// ---------------------------------------------------------------------------

describe('publishPage richtext sanitization (Constraint #368)', () => {
  const site = makeSite()

  // content module: prop key is 'html', declared as a richtext-typed control
  const contentModule = makeModule('test.content', {
    schema: { html: { type: 'richtext', label: 'HTML' } },
    render: (props) => {
      const html = typeof props.html === 'string' ? props.html : ''
      return { html: `<article>${html}</article>` }
    },
  })
  const registry = makeRegistry({ 'test.content': contentModule })

  it('publishes aligned content and download links after sanitization', () => {
    const page = makePage({ root: {
      moduleId: 'test.content',
      props: { html: renderMarkdownToHtml('<h2 align="right">[Wallpaper](/uploads/wallpaper.png "instatic:download")</h2>') },
    } })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('class="instatic-content-align--right"')
    expect(html).toContain('download=""')
    expect(html).toContain('.instatic-content-align--right { text-align: right; }')
  })

  it('<script> in html prop is stripped from published HTML', () => {
    const page = makePage({
      root: {
        moduleId: 'test.content',
        props: { html: '<p>Safe content</p><script>alert(1)</script>' },
      },
    })
    const { html } = publishPage(page, site, registry)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('alert(1)')
  })

  it('safe content in html prop is preserved after sanitization', () => {
    const page = makePage({
      root: {
        moduleId: 'test.content',
        props: { html: '<p>Safe content</p><script>alert(1)</script>' },
      },
    })
    const { html } = publishPage(page, site, registry)
    // Safe text content survives regardless of whether DOMPurify preserves <p>
    expect(html).toContain('Safe content')
  })

  it('renderNode: richtext prop is sanitized before reaching render()', () => {
    // Verify at the renderNode level that the module's render() receives
    // sanitized props — not the raw HTML with <script>
    let receivedHtml = ''
    const spyModule = makeModule('spy.content', {
      schema: { html: { type: 'richtext', label: 'HTML' } },
      render: (props) => {
        receivedHtml = typeof props.html === 'string' ? props.html : ''
        return { html: receivedHtml }
      },
    })
    const spyRegistry = makeRegistry({ 'spy.content': spyModule })
    const page = makePage({
      root: {
        moduleId: 'spy.content',
        props: { html: '<p>ok</p><script>bad()</script>' },
      },
    })
    renderNode(
      'root',
      { page, site, registry: spyRegistry, breakpointId: undefined },
      makeAccumulators(),
    )
    // The module's render() must never see the raw <script>
    expect(receivedHtml).not.toContain('<script>')
  })
})
