/**
 * The `@[video](url)` block extension, shared by both markdown entry points.
 *
 * Marked treats the line as an HTML token by default; this lifts it out to its
 * own typed token. `markdownDocument.ts` maps that token to a media node and
 * `renderMarkdown.ts` renders it to a `<video>` element, so the two supply
 * their own `renderer` and spread these lexing fields in alongside it.
 */

export const videoTokenizerExtension = {
  name: 'instaticVideo',
  level: 'block' as const,
  start(src: string) {
    return src.indexOf('@[video](')
  },
  tokenizer(src: string) {
    const match = src.match(/^@\[video\]\(([^)\s]+)\)\s*(?:\n|$)/)
    if (!match) return undefined
    return { type: 'instaticVideo', raw: match[0], href: match[1].trim() }
  },
}
