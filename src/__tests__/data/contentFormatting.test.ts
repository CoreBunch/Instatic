import { describe, expect, it } from 'bun:test'
import { markdownToProseMirrorDoc, proseMirrorDocToMarkdown, type JSONNode } from '@core/markdown/markdownDocument'
import { renderMarkdownToHtml } from '@core/markdown/renderMarkdown'
import { sanitizeRichtext } from '@core/sanitize'

describe('persisted content formatting', () => {
  for (const textAlign of ['left', 'center', 'right', 'justify']) {
    for (const type of ['paragraph', 'heading']) {
      it(`preserves ${textAlign} ${type} alignment and inline formatting`, () => {
        const doc: JSONNode = { type: 'doc', content: [{ type,
          attrs: { ...(type === 'heading' ? { level: 3 } : {}), textAlign },
          content: [{ type: 'text', text: 'Desktop', marks: [{ type: 'bold' }] }],
        }] }
        const markdown = proseMirrorDocToMarkdown(doc)
        expect(markdown).not.toBe('**Desktop**')
        expect(markdownToProseMirrorDoc(markdown)).toEqual(doc)
        expect(renderMarkdownToHtml(markdown)).toContain(`style="text-align:${textAlign}"><strong>Desktop</strong>`)
      })
    }
  }

  it('round trips downloads and emits an actual download link', () => {
    const markdown = '[Wallpaper](/uploads/wallpaper.png "instatic:download")'
    expect(proseMirrorDocToMarkdown(markdownToProseMirrorDoc(markdown))).toBe(markdown)
    expect(renderMarkdownToHtml(markdown)).toBe('<p><a href="/uploads/wallpaper.png" download>Wallpaper</a></p>')
    expect(renderMarkdownToHtml('[Wallpaper](/uploads/wallpaper.png)')).not.toContain(' download')
  })

  it('retains URL safety for download links', () => {
    expect(renderMarkdownToHtml('[bad](javascript:alert%281%29 "instatic:download")')).not.toContain('href="javascript:')
  })

  it('retains alignment and downloads through publisher sanitization', () => {
    const html = sanitizeRichtext(renderMarkdownToHtml('<p align="center">[File](/uploads/file.pdf "instatic:download")</p>'))
    expect(html).toContain('class="instatic-content-align--center"')
    expect(html).toContain('download=""')
    expect(html).not.toContain('target="_blank"')
    expect(html).not.toContain('style=')
  })

  it('keeps adjacent aligned blocks and surrounding paragraphs separate', () => {
    const markdown = 'Before\n\n<p align="center">One</p>\n\n<h2 align="right">Two</h2>\n\nAfter'
    expect(proseMirrorDocToMarkdown(markdownToProseMirrorDoc(markdown))).toBe(markdown)
  })
})
