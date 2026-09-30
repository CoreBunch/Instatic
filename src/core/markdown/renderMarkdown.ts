/**
 * Generic markdown → HTML renderer used by the publisher.
 *
 * Used by:
 *   - `src/core/templates/dynamicBindings.ts` to materialise `{{ body | html }}`
 *     bindings on template pages.
 *   - `src/core/loops/sources/dataRows.ts` to extract the first inline image from
 *     a row's body cell (via `firstImagePathFromMarkdown`, re-exported from
 *     `markdownDocument.ts`).
 *
 * Implementation: built on `marked` with GFM enabled. We wrap the standard
 * `marked.parse()` output with two boundary rules that the rest of the
 * publish pipeline relies on:
 *
 *   - **URL safety.** Every `href` / `src` value passes through `isSafeUrl`
 *     from the publisher utils. The same allow/deny-list used everywhere
 *     else in the pipeline (blocks `javascript:`, `vbscript:`, `data:` URIs,
 *     including tab/newline-evasion variants per Constraint #211 / CWE-79).
 *   - **CMS video extension.** `@[video](url)` is recognised at the block
 *     level and emits `<video controls src="...">`. This is the same syntax
 *     the editor writes for video media nodes.
 *   - **Image presentation metadata.** The content editor stores `SM` and
 *     lightbox choices in the Markdown image title (`"size=sm lightbox"`).
 *     Lightbox links open a modal via the publisher runtime and fall back
 *     to the image URL when JavaScript is unavailable.
 *
 * Anchors are normalised to `target="_blank" rel="noopener noreferrer"`.
 *
 * The grammar supported is the full GFM set:
 *   - ATX headings, fenced and indented code blocks
 *   - Inline marks: bold, italic, strike, code, links
 *   - Lists (bullet, ordered, optional task checkboxes), block quotes
 *   - Horizontal rules
 *   - GFM tables
 *   - CMS video embed `@[video](url)`
 */

import { Marked, type Tokens } from 'marked'
import { alignedBlock } from './alignedBlock'
import { escapeHtml, isSafeUrl } from '@core/html-sanitize'
import { parseMediaImageTitle, mediaImageWidth } from './mediaImagePresentation'

export { firstMediaPathFromMarkdown as firstImagePathFromMarkdown } from './markdownDocument'

const marked = new Marked({ gfm: true, breaks: false })

marked.use({
  extensions: [
    {
      ...alignedBlock,
      renderer(token: Tokens.Generic) {
        return `<${token.tag} class="instatic-content-align--${token.alignment}" style="text-align:${token.alignment}">${this.parser.parseInline(token.tokens ?? [])}</${token.tag}>\n`
      },
    },
    {
      name: 'instaticVideo',
      level: 'block',
      start(src: string) {
        return src.indexOf('@[video](')
      },
      tokenizer(src: string) {
        const match = src.match(/^@\[video\]\(([^)\s]+)\)\s*(?:\n|$)/)
        if (!match) return undefined
        return { type: 'instaticVideo', raw: match[0], href: match[1].trim() }
      },
      renderer(token: Tokens.Generic) {
        const href = typeof token.href === 'string' ? token.href : ''
        return `<video controls src="${safeMarkdownUrl(href)}"></video>`
      },
    },
  ],
  renderer: {
    link({ href, tokens, title }) {
      const inner = this.parser.parseInline(tokens)
      if (title === 'instatic:download') return `<a href="${safeMarkdownUrl(href)}" download>${inner}</a>`
      return `<a href="${safeMarkdownUrl(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    },
    image({ href, text, title }) {
      const presentation = parseMediaImageTitle(title)
      const altAttr = escapeHtml(text ?? '')
      const actualTitleAttr = presentation.title
        ? ` title="${escapeHtml(presentation.title)}"`
        : ''
      const safeSrc = safeMarkdownUrl(href)
      const width = mediaImageWidth(presentation.size)
      const image = `<img class="instatic-content-image instatic-content-image--${presentation.size}" src="${safeSrc}" alt="${altAttr}"${actualTitleAttr} loading="lazy" style="display:block;width:${width};max-width:100%;height:auto;margin-inline:auto">`

      if (!presentation.lightbox || safeSrc === '#') return image

      return `<a class="instatic-lightbox-trigger" href="${safeSrc}" aria-label="Open image in full size" style="display:block;width:${width};margin-inline:auto">${image}</a>`
    },
  },
})

function safeMarkdownUrl(value: string): string {
  // No pre-trim: `isSafeUrl` performs the full WHATWG leading/trailing strip
  // itself. A `.trim()` here would look protective while leaving exactly the
  // control characters that mattered (GHSA-pqcp-872g-gmp8).
  const raw = value ?? ''
  return isSafeUrl(raw) ? escapeHtml(raw) : '#'
}

export function renderMarkdownToHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) return ''
  try {
    return (marked.parse(markdown, { async: false }) as string).trim()
  } catch {
    // Fallback: render the raw text as escaped plain text rather than
    // crashing the publish pipeline.
    return escapeHtml(markdown)
  }
}
