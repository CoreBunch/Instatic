import { describe, expect, it } from 'bun:test'
import { sanitizeRichtext, RICHTEXT_CONTENT_CONFIG } from '@core/sanitize'
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

describe('link destinations survive save and reload (#687, point E)', () => {
  const linkDoc = (href: string): JSONNode => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PDF', marks: [{ type: 'link', attrs: { href } }] }] }],
  })

  it.each([
    // Already valid as a bare destination: written as before.
    { href: 'https://example.com/a', markdown: '[PDF](https://example.com/a)' },
    { href: 'https://en.wikipedia.org/wiki/Foo_(bar)', markdown: '[PDF](https://en.wikipedia.org/wiki/Foo_(bar))' },
    { href: 'https://e.com/<x>', markdown: '[PDF](https://e.com/<x>)' },
    // Not valid bare: written between angle brackets.
    { href: 'https://e.com/a b.pdf', markdown: '[PDF](<https://e.com/a b.pdf>)' },
    { href: 'https://e.com/a)b', markdown: '[PDF](<https://e.com/a)b>)' },
    { href: 'https://e.com/(a', markdown: '[PDF](<https://e.com/(a>)' },
    { href: 'https://e.com/a\\_b', markdown: '[PDF](<https://e.com/a\\\\_b>)' },
    { href: 'https://e.com/<x> y', markdown: '[PDF](<https://e.com/\\<x\\> y>)' },
  ])('keeps the whole URL $href', ({ href, markdown }) => {
    const serialised = proseMirrorDocToMarkdown(linkDoc(href))
    expect(serialised).toBe(markdown)
    expect(markdownToProseMirrorDoc(serialised)).toEqual(linkDoc(href))
    const html = renderMarkdownToHtml(serialised)
    expect(html).toContain('>PDF</a>')
    expect(html).not.toContain('](')
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

describe('raw HTML survives content editing (#407)', () => {
  const htmlCases = [
    '<figure class="w-richtext-align-fullwidth">\n  <div><img src="/uploads/hero_image.avif" alt=""></div>\n</figure>',
    '<div class="a_b">literal *stars*, [brackets], and \\slashes</div>',
    'Before <a href="/some_path?q=a_b" target="_blank" class="p_medium">link</a> after.',
    'Before <span title="a > b_`*~[]" data-label=some_value>text</span> after.',
    "Before <span title='a > b_value'>text</span> after.",
    'Before <!-- keep_this [comment] --> text.',
    '<svg><path clip-path="url(#clip0_2674_9364)" d="M0 0"></path></svg>',
  ]
  for (const source of htmlCases) {
    it(`preserves HTML source across repeated edits: ${source.slice(0, 55)}`, () => {
      let current = source
      for (let save = 0; save < 3; save++) {
        current = proseMirrorDocToMarkdown(markdownToProseMirrorDoc(current))
        expect(current).toBe(source)
      }
    })
  }

  it('still escapes Markdown in text between inline HTML tags', () => {
    const source = 'Before <span class="a_b">literal \\*stars\\* and an\\_underscore</span> after.'
    const saved = proseMirrorDocToMarkdown(markdownToProseMirrorDoc(source))
    expect(saved).toBe(source)
    expect(renderMarkdownToHtml(saved)).toContain('<span class="a_b">literal *stars* and an_underscore</span>')
  })

  it('leaves code and literal Markdown punctuation under their existing rules', () => {
    const source = '`<span class="a_b">` and literal \\[brackets\\] and \\*stars\\*.'
    expect(proseMirrorDocToMarkdown(markdownToProseMirrorDoc(source))).toBe(source)
    const incomplete = 'Text < unfinished_tag'
    expect(renderMarkdownToHtml(proseMirrorDocToMarkdown(markdownToProseMirrorDoc(incomplete)))).toBe(renderMarkdownToHtml(incomplete))
  })
})

it('keeps publisher sanitization effective after an HTML editing round-trip', () => {
  const source = '<div><img src="/uploads/hero_image.svg" onerror="alert(1)"><a href="javascript:alert(2)">bad link</a><script>alert(3)</script></div>'
  const saved = proseMirrorDocToMarkdown(markdownToProseMirrorDoc(source))
  const published = sanitizeRichtext(renderMarkdownToHtml(saved), RICHTEXT_CONTENT_CONFIG)
  expect(published).toContain('src="/uploads/hero_image.svg"')
  expect(published).not.toContain('onerror')
  expect(published).not.toContain('javascript:')
  expect(published).not.toContain('<script')
})
