import { Lexer } from 'marked'

/** Raw HTML blocks have no Markdown escaping inside them. */
export function isRawHtmlBlock(text: string): boolean {
  return text.length > 0 && Lexer.rules.block.gfm.html.exec(text)?.[0] === text
}

/** Escape Markdown text while preserving HTML syntax recognized by our parser. */
export function escapeMarkdownText(text: string): string {
  let out = ''
  let cursor = 0
  let searchFrom = 0
  while (searchFrom < text.length) {
    const start = text.indexOf('<', searchFrom)
    if (start === -1) break
    const tag = Lexer.rules.inline.gfm.tag.exec(text.slice(start))?.[0]
    if (!tag) {
      searchFrom = start + 1
      continue
    }
    out += escapeText(text.slice(cursor, start)) + tag
    cursor = start + tag.length
    searchFrom = cursor
  }
  return out + escapeText(text.slice(cursor))
}

function escapeText(text: string): string {
  return text.replace(/([\\`*_~[\]])/g, '\\$1')
}
