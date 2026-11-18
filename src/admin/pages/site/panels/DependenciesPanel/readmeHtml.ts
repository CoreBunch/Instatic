/**
 * Package README rendering: the publisher's markdown renderer (GFM, safe
 * URLs) followed by DOMPurify with the markdown-document allowlist, so badges
 * and tables survive while scripts, handlers and form controls never do. A
 * task list renders as a plain list: its checkboxes are form controls.
 */
import { renderMarkdownToHtml } from '@core/markdown/renderMarkdown'
import { MARKDOWN_DOCUMENT_CONFIG, sanitizeRichtext } from '@core/sanitize'

export function renderReadmeHtml(markdown: string): string {
  return sanitizeRichtext(renderMarkdownToHtml(markdown), MARKDOWN_DOCUMENT_CONFIG)
}
