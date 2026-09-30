import type { TokenizerExtension } from 'marked'

export function serializeAlignedBlock(tag: 'p' | 'h2' | 'h3' | 'h4', alignment: unknown, content: string): string | null {
  if (typeof alignment !== 'string' || !['left', 'center', 'right', 'justify'].includes(alignment)) return null
  return `<${tag} align="${alignment}">${content}</${tag}>`
}

/** Restricted HTML wrapper; its contents remain editable Markdown. */
export const alignedBlock: TokenizerExtension = {
  name: 'instaticAlignedBlock',
  level: 'block',
  start: (src) => src.search(/<(?:p|h[2-4]) align="/),
  tokenizer(src) {
    const match = src.match(/^<(p|h[2-4]) align="(left|center|right|justify)">([\s\S]*?)<\/\1>(?:\n|$)/)
    if (!match) return undefined
    return {
      type: 'instaticAlignedBlock', raw: match[0],
      tag: match[1], alignment: match[2], tokens: this.lexer.inlineTokens(match[3]),
    }
  },
}
