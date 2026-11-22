/**
 * ProseMirror JSON shape shared by the markdown parser
 * (`markdownDocument.ts`) and the inline serialiser (`inlineMarkdown.ts`).
 *
 * Just enough of it: we don't pull in @tiptap/pm here so these modules stay
 * usable from non-DOM contexts like Bun tests.
 */

export interface JSONMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface JSONNode {
  type: string
  attrs?: Record<string, unknown>
  content?: JSONNode[]
  marks?: JSONMark[]
  text?: string
}

export function sameMark(a: JSONMark, b: JSONMark): boolean {
  if (a.type !== b.type) return false
  const aAttrs = a.attrs ?? {}
  const bAttrs = b.attrs ?? {}
  const keys = new Set([...Object.keys(aAttrs), ...Object.keys(bAttrs)])
  for (const key of keys) {
    if (aAttrs[key] !== bAttrs[key]) return false
  }
  return true
}
