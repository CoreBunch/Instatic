import { describe, expect, it } from 'bun:test'
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { ContentLinkAttributes } from './ContentLinkAttributes'
import { markdownToProseMirrorDoc, proseMirrorDocToMarkdown } from '@core/markdown/markdownDocument'

describe('content download link schema', () => {
  it('keeps download metadata through the real editor and can switch back to Open', () => {
    const markdown = '[File](/uploads/file.pdf "instatic:download")'
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, ContentLinkAttributes],
      content: markdownToProseMirrorDoc(markdown),
    })
    try {
      expect(proseMirrorDocToMarkdown(editor.getJSON())).toBe(markdown)
      expect(editor.getHTML()).toContain('download=""')
      editor.chain().setTextSelection({ from: 1, to: 5 })
        .setMark('link', { href: '/uploads/file.pdf', download: null }).run()
      expect(proseMirrorDocToMarkdown(editor.getJSON())).toBe('[File](/uploads/file.pdf)')
    } finally {
      editor.destroy()
    }
  })
})
