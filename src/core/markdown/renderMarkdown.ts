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
import { escapeHtml, isSafeUrl } from '@core/html-sanitize'

import { videoTokenizerExtension } from './videoToken'

export { firstMediaPathFromMarkdown as firstImagePathFromMarkdown } from './markdownDocument'

const marked = new Marked({ gfm: true, breaks: false })

marked.use({
  extensions: [
    {
      ...videoTokenizerExtension,
      renderer(token: Tokens.Generic) {
        const href = typeof token.href === 'string' ? token.href : ''
        return `<video controls src="${safeMarkdownUrl(href)}"></video>`
      },
    },
  ],
  renderer: {
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens)
      return `<a href="${safeMarkdownUrl(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    },
    image({ href, text, title }) {
      const altAttr = escapeHtml(text ?? '')
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      return `<img src="${safeMarkdownUrl(href)}" alt="${altAttr}"${titleAttr} loading="lazy">`
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
