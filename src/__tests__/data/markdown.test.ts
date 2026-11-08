import { describe, expect, it } from 'bun:test'
import {
  firstMediaPathFromMarkdown,
  markdownToProseMirrorDoc,
  proseMirrorDocToMarkdown,
} from '@core/markdown/markdownDocument'
import type { JSONNode } from '@core/markdown/proseMirrorJson'
import { renderMarkdownToHtml } from '@core/markdown/renderMarkdown'

describe('content markdown ↔ ProseMirror document', () => {
  it('parses headings, paragraphs and a single-line image into a doc tree', () => {
    const doc = markdownToProseMirrorDoc([
      '## Intro',
      '',
      'A paragraph.',
      '',
      '![Hero](/uploads/hero.png)',
      '',
      '@[video](/uploads/movie.mp4)',
    ].join('\n'))

    expect(doc).toMatchObject({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Intro' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'A paragraph.' }] },
        { type: 'media', attrs: { mediaType: 'image', src: '/uploads/hero.png', alt: 'Hero' } },
        { type: 'media', attrs: { mediaType: 'video', src: '/uploads/movie.mp4', alt: '' } },
      ],
    })
  })

  it('round-trips inline marks (bold, italic, strike, code, link)', () => {
    const source = 'Hello **bold** *italic* ~~strike~~ `code` and [a link](https://example.com).'
    const doc = markdownToProseMirrorDoc(source)
    const serialised = proseMirrorDocToMarkdown(doc)
    expect(serialised).toBe(source)
    // And re-parsing the output yields the same tree.
    expect(markdownToProseMirrorDoc(serialised)).toEqual(doc)
  })

  it('round-trips underline via inline <u> HTML, including when nested in bold / italic', () => {
    const source = 'Hello <u>underlined</u> world and **bold <u>combo</u>** plus *italic <u>inside</u>* too.'
    const doc = markdownToProseMirrorDoc(source)
    expect(proseMirrorDocToMarkdown(doc)).toBe(source)
    // Mark stacks must reflect both the wrapping mark and the nested
    // underline — that's what makes Cmd-U preserve through save/reload.
    const para = doc.content?.[0]
    const textNodes = (para?.content ?? []).filter((c) => c.type === 'text')
    const nestedBoldUnderline = textNodes.find((n) => n.text === 'combo')
    expect(nestedBoldUnderline?.marks?.map((m) => m.type).sort()).toEqual(['bold', 'underline'])
    const nestedItalicUnderline = textNodes.find((n) => n.text === 'inside')
    expect(nestedItalicUnderline?.marks?.map((m) => m.type).sort()).toEqual(['italic', 'underline'])
  })

  it('round-trips bullet and ordered lists', () => {
    const source = ['- one', '- two', '- three'].join('\n')
    expect(proseMirrorDocToMarkdown(markdownToProseMirrorDoc(source))).toBe(source)

    const ordered = ['1. one', '1. two', '1. three'].join('\n')
    const orderedDoc = markdownToProseMirrorDoc(ordered)
    expect(orderedDoc.content?.[0].type).toBe('orderedList')
    expect(proseMirrorDocToMarkdown(orderedDoc)).toBe(ordered)
  })

  it('round-trips blockquotes, code blocks and horizontal rules', () => {
    const source = [
      '> a quoted line',
      '> another',
      '',
      '```js',
      "console.log('hi')",
      '```',
      '',
      '---',
      '',
      'after',
    ].join('\n')
    const serialised = proseMirrorDocToMarkdown(markdownToProseMirrorDoc(source))
    // Reparsing the serialised form yields the same tree as parsing the
    // original — that's the canonicalisation guarantee.
    expect(markdownToProseMirrorDoc(serialised)).toEqual(markdownToProseMirrorDoc(source))
    expect(serialised).toContain('> a quoted line')
    expect(serialised).toContain('```js')
    expect(serialised).toContain('---')
  })

  it('parses GFM tables into a table node', () => {
    const source = ['| Col A | Col B |', '| --- | --- |', '| a1 | b1 |', '| a2 | b2 |'].join('\n')
    const doc = markdownToProseMirrorDoc(source)
    const table = doc.content?.[0] as JSONNode
    expect(table?.type).toBe('table')
    expect(table?.content?.length).toBe(3)
    // Re-serialise and re-parse — same tree.
    const reSerialised = proseMirrorDocToMarkdown(doc)
    expect(markdownToProseMirrorDoc(reSerialised)).toEqual(doc)
  })

  it('clamps headings outside h2-h4 to the post-body range', () => {
    const doc = markdownToProseMirrorDoc(['# Top', '', '###### Deep'].join('\n'))
    expect(doc.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
    expect(doc.content?.[1]).toMatchObject({ type: 'heading', attrs: { level: 4 } })
  })

  it('returns a single empty paragraph for empty input', () => {
    expect(markdownToProseMirrorDoc('')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    })
  })
})

describe('inline marks with whitespace at their edges', () => {
  const text = (value: string, ...marks: string[]): JSONNode =>
    marks.length > 0
      ? { type: 'text', text: value, marks: marks.map((type) => ({ type })) }
      : { type: 'text', text: value }
  const paragraph = (...content: JSONNode[]): JSONNode => ({
    type: 'doc',
    content: [{ type: 'paragraph', content }],
  })

  // A double-click on Windows selects the word plus its trailing space, so
  // the marked run is `word ` — CommonMark rejects `**word **` as emphasis.
  it.each([
    { mark: 'bold', before: 'a ', run: 'word ', after: 'b', markdown: 'a **word** b', html: '<p>a <strong>word</strong> b</p>' },
    { mark: 'bold', before: 'a', run: ' word', after: 'b', markdown: 'a **word**b', html: '<p>a <strong>word</strong>b</p>' },
    { mark: 'italic', before: 'a ', run: 'word ', after: 'b', markdown: 'a *word* b', html: '<p>a <em>word</em> b</p>' },
    { mark: 'strike', before: 'a ', run: 'word ', after: 'b', markdown: 'a ~~word~~ b', html: '<p>a <del>word</del> b</p>' },
    { mark: 'bold', before: 'a ', run: 'word', after: ' b', markdown: 'a **word** b', html: '<p>a <strong>word</strong> b</p>' },
  ])('serialises a $mark run "$run" with its delimiters against the word', ({ mark, before, run, after, markdown, html }) => {
    const serialised = proseMirrorDocToMarkdown(paragraph(text(before), text(run, mark), text(after)))
    expect(serialised).toBe(markdown)
    expect(renderMarkdownToHtml(serialised).trim()).toBe(html)
  })

  it('drops the mark from a run that is only whitespace', () => {
    expect(proseMirrorDocToMarkdown(paragraph(text('a'), text(' ', 'bold'), text('b')))).toBe('a b')
  })

  it('keeps whitespace inside a mark that continues into the next run', () => {
    const serialised = proseMirrorDocToMarkdown(
      paragraph(text('a '), text('one ', 'bold'), text('two', 'bold', 'italic'), text(' c')),
    )
    expect(serialised).toBe('a **one *two*** c')
    expect(renderMarkdownToHtml(serialised).trim()).toBe('<p>a <strong>one <em>two</em></strong> c</p>')
  })

  it('keeps a nested mark valid when its run starts with whitespace', () => {
    const serialised = proseMirrorDocToMarkdown(paragraph(text('a', 'italic'), text(' b', 'bold', 'italic')))
    expect(serialised).toBe('*a **b***')
    expect(renderMarkdownToHtml(serialised).trim()).toBe('<p><em>a <strong>b</strong></em></p>')
  })

  it('re-parses the moved whitespace as unmarked text', () => {
    const serialised = proseMirrorDocToMarkdown(paragraph(text('a '), text('word ', 'bold'), text('b')))
    expect(markdownToProseMirrorDoc(serialised)).toEqual(paragraph(text('a '), text('word', 'bold'), text(' b')))
  })
})

describe('publisher markdown renderer', () => {
  it('renders the extended grammar via marked', () => {
    const html = renderMarkdownToHtml(
      ['## Heading', '', '**bold** and *italic*', '', '- one', '- two'].join('\n'),
    )
    expect(html).toContain('<h2>Heading</h2>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<ul>')
  })

  it('emits safe URLs and target=_blank for inline links', () => {
    const html = renderMarkdownToHtml('See [the docs](https://example.com).')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('drops javascript: URLs in images and links', () => {
    const html = renderMarkdownToHtml('![bad](javascript:alert(1))')
    expect(html).toContain('src="#"')
  })

  it('emits a controls-bearing video element for @[video](url) lines', () => {
    const html = renderMarkdownToHtml('@[video](/uploads/clip.mp4)')
    expect(html).toContain('<video')
    expect(html).toContain('controls')
    expect(html).toContain('src="/uploads/clip.mp4"')
  })
})

describe('firstMediaPathFromMarkdown', () => {
  it('returns the first image URL when present', () => {
    expect(firstMediaPathFromMarkdown('intro\n\n![Alt](/uploads/a.png)\n\nrest')).toBe('/uploads/a.png')
  })

  it('returns the first video URL when no images precede it', () => {
    expect(firstMediaPathFromMarkdown('intro\n\n@[video](/uploads/clip.mp4)')).toBe('/uploads/clip.mp4')
  })

  it('returns null when no media is present', () => {
    expect(firstMediaPathFromMarkdown('just text')).toBeNull()
  })
})
