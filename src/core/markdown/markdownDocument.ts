/**
 * Markdown ↔ ProseMirror document round-trip for the content editor.
 *
 * The content body cell stores plain markdown text. Tiptap edits a
 * ProseMirror JSON document. This module is the bridge: feed it markdown,
 * get back a doc tree the editor accepts; feed it the editor's doc tree,
 * get back markdown that re-parses to the same tree.
 *
 * The grammar matches the publisher's `renderMarkdownToHtml` (GFM via
 * `marked`) plus two CMS extensions:
 *   - `@[video](url)` — a video media node (parsed by a custom marked
 *     tokenizer; serialised back as the same raw line)
 *   - Images on their own line are promoted to a block-level `media` node
 *     rather than wrapped in a paragraph
 *
 * Headings are clamped to h2-h4. The title of a post owns h1, so anything
 * shallower is normalised up to h2 and anything deeper is normalised down
 * to h4 — same rule the old block-list editor enforced.
 *
 * Round-trip property: for any input `md`,
 *   `proseMirrorDocToMarkdown(markdownToProseMirrorDoc(md))`
 * yields a stable string that re-parses to the same JSON. The reverse
 * (`markdown -> doc -> markdown`) is **canonical** — extra whitespace,
 * trailing blank lines, and trivial syntactic variations are normalised
 * away on the way through.
 */

import { Marked, type Tokens, type Token } from 'marked'

// ---------------------------------------------------------------------------
// ProseMirror JSON shape (just enough — we don't pull in @tiptap/pm here so
// this module stays usable from non-DOM contexts like Bun tests)
// ---------------------------------------------------------------------------

interface JSONMark {
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

type DocNode = JSONNode & { type: 'doc' }

// ---------------------------------------------------------------------------
// Marked configuration — single instance, no globals.
// ---------------------------------------------------------------------------

const VIDEO_RE = /^@\[video\]\(([^)\s]+)\)\s*$/

const marked = new Marked({ gfm: true })

// Register a block-level tokenizer for `@[video](url)`. Marked treats the
// line as an HTML token by default; this lifts it out to its own typed
// token so the walker can map it to a media node.
marked.use({
  extensions: [
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
      renderer() {
        // We never use marked to render — only to lex. Return empty.
        return ''
      },
    },
  ],
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a markdown string into a ProseMirror `doc` node. Always returns a
 * doc with at least one child (an empty paragraph) so Tiptap can mount.
 */
export function markdownToProseMirrorDoc(markdown: string): DocNode {
  const tokens = marked.lexer(markdown ?? '')
  const content = tokensToBlockNodes(tokens)
  if (content.length === 0) {
    content.push(emptyParagraph())
  }
  return { type: 'doc', content }
}

/**
 * Serialise a ProseMirror `doc` node back to markdown. Output is canonical:
 * blocks separated by single blank lines, marks emitted in a stable order,
 * trailing whitespace stripped.
 */
export function proseMirrorDocToMarkdown(doc: JSONNode): string {
  if (!doc || doc.type !== 'doc' || !doc.content) return ''
  return blockNodesToMarkdown(doc.content).trim()
}

// ---------------------------------------------------------------------------
// markdown → JSON: token walker
// ---------------------------------------------------------------------------

function tokensToBlockNodes(tokens: Token[]): JSONNode[] {
  const out: JSONNode[] = []
  for (const token of tokens) {
    const node = tokenToBlockNode(token)
    if (Array.isArray(node)) out.push(...node)
    else if (node) out.push(node)
  }
  return out
}

function tokenToBlockNode(token: Token): JSONNode | JSONNode[] | null {
  switch (token.type) {
    case 'paragraph':
      return paragraphTokenToNode(token as Tokens.Paragraph)
    case 'heading':
      return headingTokenToNode(token as Tokens.Heading)
    case 'blockquote':
      return {
        type: 'blockquote',
        content: tokensToBlockNodes((token as Tokens.Blockquote).tokens),
      }
    case 'list':
      return listTokenToNode(token as Tokens.List)
    case 'code':
      return codeBlockTokenToNode(token as Tokens.Code)
    case 'hr':
      return { type: 'horizontalRule' }
    case 'table':
      return tableTokenToNode(token as Tokens.Table)
    case 'space':
      return null
    case 'html': {
      // Block HTML — preserve the raw source as a paragraph so authors don't
      // lose content. Sanitisation happens at publish time.
      const raw = (token as Tokens.HTML).raw.trim()
      if (!raw) return null
      return { type: 'paragraph', content: [{ type: 'text', text: raw }] }
    }
    default:
      // Custom tokens (e.g. instaticVideo)
      if (token.type === 'instaticVideo') {
        const href = (token as unknown as { href?: unknown }).href
        if (typeof href === 'string') {
          return mediaNode('video', href, '')
        }
      }
      return null
  }
}

function paragraphTokenToNode(token: Tokens.Paragraph): JSONNode | JSONNode[] {
  // An "image-only" paragraph (just `![alt](src)`) is promoted to a
  // block-level media node — that's the shape the editor renders, and
  // the shape the publisher already supports.
  const inline = token.tokens ?? []
  if (inline.length === 1 && inline[0].type === 'image') {
    const img = inline[0] as Tokens.Image
    return mediaNode('image', img.href, img.text)
  }

  // Multiple inline tokens but the only non-text content is an image →
  // split the paragraph at the image boundary.
  const onlyImagesAndText = inline.every((t) => t.type === 'image' || t.type === 'text' || t.type === 'space')
  if (onlyImagesAndText && inline.some((t) => t.type === 'image')) {
    const nodes: JSONNode[] = []
    let buffer: Token[] = []
    const flush = () => {
      if (buffer.length === 0) return
      const content = inlineTokensToNodes(buffer, [])
      if (content.length > 0) nodes.push({ type: 'paragraph', content })
      buffer = []
    }
    for (const t of inline) {
      if (t.type === 'image') {
        flush()
        const img = t as Tokens.Image
        nodes.push(mediaNode('image', img.href, img.text))
      } else {
        buffer.push(t)
      }
    }
    flush()
    return nodes
  }

  const content = inlineTokensToNodes(inline, [])
  return { type: 'paragraph', content: content.length > 0 ? content : undefined }
}

function headingTokenToNode(token: Tokens.Heading): JSONNode {
  const level = clampHeadingLevel(token.depth)
  const content = inlineTokensToNodes(token.tokens ?? [], [])
  return {
    type: 'heading',
    attrs: { level },
    content: content.length > 0 ? content : undefined,
  }
}

function listTokenToNode(token: Tokens.List): JSONNode {
  const items: JSONNode[] = token.items.map((item) => {
    // A list item's `tokens` may be a flat list of inline tokens (tight
    // list) or a sequence of block tokens (loose list). Normalise by
    // wrapping any leading inline run in a paragraph.
    const itemBlocks = listItemTokensToBlocks(item.tokens)
    return {
      type: 'listItem',
      content: itemBlocks.length > 0 ? itemBlocks : [emptyParagraph()],
    }
  })

  if (token.ordered) {
    const start = typeof token.start === 'number' ? token.start : 1
    return {
      type: 'orderedList',
      attrs: start === 1 ? undefined : { start },
      content: items,
    }
  }
  return { type: 'bulletList', content: items }
}

function listItemTokensToBlocks(tokens: Token[]): JSONNode[] {
  const blocks: JSONNode[] = []
  let inlineBuffer: Token[] = []
  const flushInline = () => {
    if (inlineBuffer.length === 0) return
    const content = inlineTokensToNodes(inlineBuffer, [])
    if (content.length > 0) blocks.push({ type: 'paragraph', content })
    inlineBuffer = []
  }
  for (const token of tokens) {
    if (isInlineTokenType(token.type)) {
      inlineBuffer.push(token)
      continue
    }
    flushInline()
    const block = tokenToBlockNode(token)
    if (Array.isArray(block)) blocks.push(...block)
    else if (block) blocks.push(block)
  }
  flushInline()
  return blocks
}

function codeBlockTokenToNode(token: Tokens.Code): JSONNode {
  const text = token.text ?? ''
  return {
    type: 'codeBlock',
    attrs: token.lang ? { language: token.lang } : undefined,
    content: text.length > 0 ? [{ type: 'text', text }] : undefined,
  }
}

function tableTokenToNode(token: Tokens.Table): JSONNode {
  const headerRow: JSONNode = {
    type: 'tableRow',
    content: token.header.map((cell) => ({
      type: 'tableHeader',
      content: [paragraphFromInline(cell.tokens)],
    })),
  }
  const bodyRows: JSONNode[] = token.rows.map((row) => ({
    type: 'tableRow',
    content: row.map((cell) => ({
      type: 'tableCell',
      content: [paragraphFromInline(cell.tokens)],
    })),
  }))
  return { type: 'table', content: [headerRow, ...bodyRows] }
}

function paragraphFromInline(tokens: Token[]): JSONNode {
  const content = inlineTokensToNodes(tokens ?? [], [])
  return { type: 'paragraph', content: content.length > 0 ? content : undefined }
}

// ---------------------------------------------------------------------------
// Inline token walker — accumulates marks down the recursion stack
// ---------------------------------------------------------------------------

function inlineTokensToNodes(tokens: Token[], marks: JSONMark[]): JSONNode[] {
  const out: JSONNode[] = []
  pushInlineGroup(out, tokens, marks)
  return mergeAdjacentText(out)
}

/**
 * Expand inline `<u>` … `</u>` HTML pairs into synthetic `instaticUnderline`
 * tokens, then walk each resulting token with the given mark stack.
 * Called at the entry point AND whenever the walker recurses into a
 * marked child group (em / strong / del / link / instaticUnderline), so nested
 * underlines inside bold / italic / etc. survive the round-trip.
 *
 * Markdown has no native underline syntax — we round-trip it as inline
 * HTML, which is the only stable way to keep underline marks across
 * save + reload cycles.
 */
function pushInlineGroup(out: JSONNode[], tokens: Token[], marks: JSONMark[]): void {
  const expanded = expandInlineHtmlMarkPairs(tokens, '<u>', '</u>', 'instaticUnderline')
  for (const token of expanded) pushInline(out, token, marks)
}

function expandInlineHtmlMarkPairs(
  tokens: Token[],
  openTag: string,
  closeTag: string,
  syntheticType: string,
): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t.type === 'html' && htmlTokenIs(t, openTag)) {
      // Scan ahead for the matching close tag at the same nesting level.
      let depth = 1
      let j = i + 1
      while (j < tokens.length && depth > 0) {
        const candidate = tokens[j]
        if (candidate.type === 'html') {
          if (htmlTokenIs(candidate, openTag)) depth++
          else if (htmlTokenIs(candidate, closeTag)) depth--
        }
        if (depth === 0) break
        j++
      }
      if (j < tokens.length && depth === 0) {
        const inner = tokens.slice(i + 1, j)
        out.push({
          type: syntheticType,
          raw: '',
          tokens: expandInlineHtmlMarkPairs(inner, openTag, closeTag, syntheticType),
        } as unknown as Token)
        i = j + 1
        continue
      }
    }
    out.push(t)
    i++
  }
  return out
}

function htmlTokenIs(token: Token, tag: string): boolean {
  if (token.type !== 'html') return false
  const text = ((token as Tokens.HTML).text ?? '').trim().toLowerCase()
  return text === tag.toLowerCase()
}

function pushInline(out: JSONNode[], token: Token, marks: JSONMark[]): void {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text
      // Marked nests inline tokens inside `text` when it contains parsed
      // children (e.g. links inside a text span). Honour that.
      if (t.tokens && t.tokens.length > 0) {
        for (const inner of t.tokens) pushInline(out, inner, marks)
      } else if (t.text) {
        out.push(textNode(decodeEntities(t.text), marks))
      }
      return
    }
    case 'escape': {
      out.push(textNode((token as Tokens.Escape).text, marks))
      return
    }
    case 'em': {
      pushInlineGroup(out, (token as Tokens.Em).tokens ?? [], addMark(marks, { type: 'italic' }))
      return
    }
    case 'strong': {
      pushInlineGroup(out, (token as Tokens.Strong).tokens ?? [], addMark(marks, { type: 'bold' }))
      return
    }
    case 'del': {
      pushInlineGroup(out, (token as Tokens.Del).tokens ?? [], addMark(marks, { type: 'strike' }))
      return
    }
    case 'codespan': {
      out.push(textNode(decodeEntities((token as Tokens.Codespan).text), addMark(marks, { type: 'code' })))
      return
    }
    case 'link': {
      const link = token as Tokens.Link
      const linkMark: JSONMark = { type: 'link', attrs: { href: link.href } }
      pushInlineGroup(out, link.tokens ?? [], addMark(marks, linkMark))
      return
    }
    case 'image': {
      // Inline image embedded mid-paragraph — render as a media node
      // sibling. Tiptap's schema doesn't allow inline non-text nodes
      // inside paragraphs by default; pushing it as a sibling at the
      // block level via the paragraph walker is handled above. Here we
      // fall through to plain alt-text so paragraphs still serialise.
      const img = token as Tokens.Image
      if (img.text) out.push(textNode(img.text, marks))
      return
    }
    case 'br':
      out.push({ type: 'hardBreak' })
      return
    case 'html': {
      const raw = (token as Tokens.HTML).text
      if (raw) out.push(textNode(raw, marks))
      return
    }
    case 'instaticUnderline': {
      const inner = (token as unknown as { tokens?: Token[] }).tokens ?? []
      pushInlineGroup(out, inner, addMark(marks, { type: 'underline' }))
      return
    }
    default: {
      const text = (token as { text?: string }).text
      if (typeof text === 'string') out.push(textNode(decodeEntities(text), marks))
    }
  }
}

function textNode(text: string, marks: JSONMark[]): JSONNode {
  return marks.length > 0
    ? { type: 'text', text, marks: marks.map(cloneMark) }
    : { type: 'text', text }
}

function addMark(marks: JSONMark[], mark: JSONMark): JSONMark[] {
  if (marks.some((m) => sameMark(m, mark))) return marks
  return [...marks, mark]
}

function sameMark(a: JSONMark, b: JSONMark): boolean {
  if (a.type !== b.type) return false
  const aAttrs = a.attrs ?? {}
  const bAttrs = b.attrs ?? {}
  const keys = new Set([...Object.keys(aAttrs), ...Object.keys(bAttrs)])
  for (const key of keys) {
    if (aAttrs[key] !== bAttrs[key]) return false
  }
  return true
}

function cloneMark(mark: JSONMark): JSONMark {
  return mark.attrs ? { type: mark.type, attrs: { ...mark.attrs } } : { type: mark.type }
}

function mergeAdjacentText(nodes: JSONNode[]): JSONNode[] {
  const out: JSONNode[] = []
  for (const node of nodes) {
    const previous = out[out.length - 1]
    if (
      node.type === 'text' &&
      previous &&
      previous.type === 'text' &&
      sameMarks(previous.marks, node.marks)
    ) {
      previous.text = (previous.text ?? '') + (node.text ?? '')
    } else {
      out.push(node)
    }
  }
  return out
}

function sameMarks(a: JSONMark[] | undefined, b: JSONMark[] | undefined): boolean {
  const aArr = a ?? []
  const bArr = b ?? []
  if (aArr.length !== bArr.length) return false
  return aArr.every((mark, index) => sameMark(mark, bArr[index]))
}

// ---------------------------------------------------------------------------
// JSON → markdown
// ---------------------------------------------------------------------------

function blockNodesToMarkdown(nodes: JSONNode[]): string {
  return nodes.map(blockNodeToMarkdown).filter((line) => line.length > 0).join('\n\n')
}

function blockNodeToMarkdown(node: JSONNode): string {
  switch (node.type) {
    // Note: paragraph / heading nodes may carry a `textAlign` attribute
    // (set by the TextAlign extension in the editor). Markdown has no
    // native alignment syntax, so the attribute is intentionally NOT
    // serialised here in v1 — alignment is an editor-session only
    // affordance. Persisting it would require wrapping the block in
    // inline HTML (`<div class="text-align-…">…</div>`), which adds a
    // round-trip parser + a publisher CSS rule, both of which are a
    // separate follow-up. Authors using alignment today will see it
    // visually while editing; it resets after save+reload.
    case 'paragraph':
      return inlineToMarkdown(node.content ?? [])
    case 'heading': {
      const level = clampHeadingLevel(numberAttr(node, 'level', 2))
      return `${'#'.repeat(level)} ${inlineToMarkdown(node.content ?? [])}`
    }
    case 'blockquote':
      return blockNodesToMarkdown(node.content ?? [])
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n')
    case 'bulletList':
      return listToMarkdown(node, '-')
    case 'orderedList': {
      const start = numberAttr(node, 'start', 1)
      return listToMarkdown(node, `${start}.`)
    }
    case 'codeBlock': {
      const language = stringAttr(node, 'language', '')
      const text = (node.content ?? []).map((child) => child.text ?? '').join('')
      return `\`\`\`${language}\n${text}\n\`\`\``
    }
    case 'horizontalRule':
      return '---'
    case 'table':
      return tableToMarkdown(node)
    case 'media': {
      const src = stringAttr(node, 'src', '')
      if (!src) return ''
      const mediaType = stringAttr(node, 'mediaType', 'image')
      if (mediaType === 'video') return `@[video](${src})`
      const alt = stringAttr(node, 'alt', '')
      return `![${alt}](${src})`
    }
    default:
      return ''
  }
}

function listToMarkdown(node: JSONNode, marker: string): string {
  const items = node.content ?? []
  return items
    .map((item) => {
      const inner = blockNodesToMarkdown(item.content ?? [])
      const prefix = marker
      const indent = ' '.repeat(prefix.length + 1)
      const lines = inner.split('\n')
      return lines.map((line, index) => (index === 0 ? `${prefix} ${line}` : line.length > 0 ? `${indent}${line}` : '')).join('\n')
    })
    .join('\n')
}

function tableToMarkdown(node: JSONNode): string {
  const rows = node.content ?? []
  if (rows.length === 0) return ''
  const headerRow = rows[0]
  const headerCells = (headerRow.content ?? []).map(cellToInline)
  const bodyRows = rows.slice(1).map((row) => (row.content ?? []).map(cellToInline))
  const columnCount = Math.max(headerCells.length, ...bodyRows.map((row) => row.length))
  if (columnCount === 0) return ''
  const pad = (cells: string[]) => {
    const padded = cells.slice()
    while (padded.length < columnCount) padded.push('')
    return padded
  }
  const header = `| ${pad(headerCells).join(' | ')} |`
  const separator = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`
  const body = bodyRows.map((row) => `| ${pad(row).join(' | ')} |`).join('\n')
  return body.length > 0 ? `${header}\n${separator}\n${body}` : `${header}\n${separator}`
}

function cellToInline(cell: JSONNode): string {
  const paragraphs = (cell.content ?? []).filter((c) => c.type === 'paragraph')
  return paragraphs.map((p) => inlineToMarkdown(p.content ?? [])).join(' ')
}

// ---------------------------------------------------------------------------
// Inline serializer — emits mark deltas
// ---------------------------------------------------------------------------

interface InlineRun {
  text: string
  marks: JSONMark[]
}

function inlineToMarkdown(nodes: JSONNode[]): string {
  const runs: InlineRun[] = []
  collectInlineRuns(nodes, runs)
  return runsToMarkdown(runs)
}

function collectInlineRuns(nodes: JSONNode[], runs: InlineRun[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push({ text: node.text ?? '', marks: node.marks ?? [] })
    } else if (node.type === 'hardBreak') {
      runs.push({ text: '\n', marks: [] })
    }
    // Other inline node types (none today) would slot in here.
  }
}

const MARK_OPEN: Record<string, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
}

// Marks with asymmetric open/close (link, underline) are handled
// explicitly in `openMark` / `closeMark`. Listed here purely so the
// mark-sort below has a stable ordering for them.
const MARK_ORDER = ['link', 'underline', 'code', 'bold', 'italic', 'strike']

function runsToMarkdown(runs: InlineRun[]): string {
  // Normalise mark order so identical mark sets produce identical
  // open/close sequences. Code is the innermost mark by convention.
  const normalised = runs.map((run) => ({
    text: run.text,
    marks: [...run.marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type)),
  }))

  let out = ''
  const active: JSONMark[] = []
  for (const run of normalised) {
    const next = run.marks
    // Close marks that aren't in `next` (in reverse open order).
    while (active.length > 0 && !marksContain(next, active[active.length - 1])) {
      const closed = active.pop()
      if (closed) out += closeMark(closed)
    }
    // Open marks that aren't in `active`.
    for (const mark of next) {
      if (!marksContain(active, mark)) {
        out += openMark(mark)
        active.push(mark)
      }
    }
    out += escapeInline(run.text, active)
  }
  while (active.length > 0) {
    const closed = active.pop()
    if (closed) out += closeMark(closed)
  }
  return out
}

function marksContain(list: JSONMark[], mark: JSONMark): boolean {
  return list.some((m) => sameMark(m, mark))
}

function openMark(mark: JSONMark): string {
  if (mark.type === 'link') return '['
  if (mark.type === 'underline') return '<u>'
  return MARK_OPEN[mark.type] ?? ''
}

function closeMark(mark: JSONMark): string {
  if (mark.type === 'link') {
    const href = (mark.attrs?.href ?? '') as string
    return `](${href})`
  }
  if (mark.type === 'underline') return '</u>'
  return MARK_OPEN[mark.type] ?? ''
}

function escapeInline(text: string, marks: JSONMark[]): string {
  // Inside a code mark, no escaping (and no marks inside it anyway).
  if (marks.some((m) => m.type === 'code')) return text
  // Escape characters that would otherwise be parsed as markdown.
  return text.replace(/([\\`*_~[\]])/g, '\\$1')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampHeadingLevel(level: number): 2 | 3 | 4 {
  if (level <= 2) return 2
  if (level >= 4) return 4
  return 3
}

function emptyParagraph(): JSONNode {
  return { type: 'paragraph' }
}

function mediaNode(mediaType: 'image' | 'video', src: string, alt: string): JSONNode {
  return {
    type: 'media',
    attrs: { mediaType, src, alt },
  }
}

function isInlineTokenType(type: string): boolean {
  return (
    type === 'text' ||
    type === 'em' ||
    type === 'strong' ||
    type === 'del' ||
    type === 'codespan' ||
    type === 'link' ||
    type === 'image' ||
    type === 'br' ||
    type === 'escape' ||
    type === 'html'
  )
}

function numberAttr(node: JSONNode, key: string, fallback: number): number {
  const value = node.attrs?.[key]
  return typeof value === 'number' ? value : fallback
}

function stringAttr(node: JSONNode, key: string, fallback: string): string {
  const value = node.attrs?.[key]
  return typeof value === 'string' ? value : fallback
}

function decodeEntities(text: string): string {
  // Marked HTML-encodes `&`, `<`, `>`, `"` and `'` in inline text tokens.
  // Decode the small fixed set so the editor sees the author's real input.
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * Extract the URL of the first image / video in a markdown document, or
 * `null` if there isn't one. Used by `firstImagePathFromMarkdown` in the
 * publisher to expose a representative image without requiring a separate
 * featured-media field.
 */
export function firstMediaPathFromMarkdown(markdown: string): string | null {
  if (!markdown) return null
  // Cheap line scan — avoids a full parse for this read-only path.
  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    const image = trimmed.match(/^!\[[^\]]*\]\(([^)\s]+)\)/)
    if (image) return image[1].trim()
    const video = trimmed.match(VIDEO_RE)
    if (video) return video[1].trim()
  }
  return null
}
