/**
 * prettyProjection — the HTML projection, indented for reading.
 *
 * The publisher emits the projection as one line. For the panel it is
 * reflowed so that every element whose children are all elements gets
 * them on their own indented lines; an element with text content (a text
 * leaf, or text mixed with inline markup) stays on one line, so no
 * whitespace is introduced where it would be significant. Nothing inside
 * `pre`, `textarea`, `script` or `style` is touched.
 *
 * Safe to round-trip: the importer ignores whitespace between the element
 * children of a container and collapses whitespace inside text leaves.
 * Works on the generated projection text directly — tags are scanned, not
 * re-serialised — so entities, attribute quoting and `uid`s stay verbatim.
 */
import { VOID_HTML_ELEMENTS } from '@core/htmlAttributes'

const INDENT = '  '
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['pre', 'textarea', 'script', 'style'])

type Token =
  | { kind: 'open'; name: string; raw: string; selfClosing: boolean }
  | { kind: 'close'; name: string; raw: string }
  | { kind: 'text'; raw: string }

interface ElementNode {
  kind: 'element'
  name: string
  open: string
  close: string | null
  children: TreeNode[]
}
interface TextNode {
  kind: 'text'
  raw: string
}
type TreeNode = ElementNode | TextNode

/** Scan `<…>` tags respecting quoted attribute values; everything else is text. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < html.length) {
    const open = html.indexOf('<', i)
    if (open < 0) {
      tokens.push({ kind: 'text', raw: html.slice(i) })
      break
    }
    if (open > i) tokens.push({ kind: 'text', raw: html.slice(i, open) })
    const tag = scanTag(html, open)
    if (!tag) {
      tokens.push({ kind: 'text', raw: html.slice(open) })
      break
    }
    tokens.push(tag.token)
    i = tag.end
  }
  return tokens
}

function scanTag(html: string, start: number): { token: Token; end: number } | null {
  let i = start + 1
  let quote: string | null = null
  while (i < html.length) {
    const ch = html[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      const raw = html.slice(start, i + 1)
      if (raw.startsWith('<!')) return { token: { kind: 'text', raw }, end: i + 1 }
      const isClose = raw.startsWith('</')
      const name = /^<\/?([A-Za-z][\w:-]*)/.exec(raw)?.[1]?.toLowerCase() ?? ''
      if (!name) return { token: { kind: 'text', raw }, end: i + 1 }
      return {
        token: isClose
          ? { kind: 'close', name, raw }
          : { kind: 'open', name, raw, selfClosing: raw.endsWith('/>') || VOID_HTML_ELEMENTS.has(name) },
        end: i + 1,
      }
    }
    i++
  }
  return null
}

function buildTree(tokens: Token[]): TreeNode[] {
  const root: TreeNode[] = []
  const stack: ElementNode[] = []
  const siblings = () => (stack.length > 0 ? stack[stack.length - 1].children : root)
  for (const token of tokens) {
    if (token.kind === 'text') {
      siblings().push({ kind: 'text', raw: token.raw })
    } else if (token.kind === 'open') {
      const element: ElementNode = { kind: 'element', name: token.name, open: token.raw, close: null, children: [] }
      siblings().push(element)
      if (!token.selfClosing) stack.push(element)
    } else {
      // Close the nearest open element of that name; anything unmatched
      // (malformed input) is kept as text so no markup is lost.
      let depth = stack.length - 1
      while (depth >= 0 && stack[depth].name !== token.name) depth--
      if (depth < 0) {
        siblings().push({ kind: 'text', raw: token.raw })
        continue
      }
      while (stack.length > depth + 1) stack.pop()
      const element = stack.pop()!
      element.close = token.raw
    }
  }
  return root
}

function isBlankText(node: TreeNode): boolean {
  return node.kind === 'text' && node.raw.trim() === ''
}

/** Children are elements only (blank text between them does not count). */
function hasOnlyElementChildren(element: ElementNode): boolean {
  const meaningful = element.children.filter((child) => !isBlankText(child))
  return meaningful.length > 0 && meaningful.every((child) => child.kind === 'element')
}

function printInline(node: TreeNode): string {
  if (node.kind === 'text') return node.raw
  return node.open + node.children.map(printInline).join('') + (node.close ?? '')
}

function printNode(node: TreeNode, depth: number): string {
  if (node.kind === 'text') return INDENT.repeat(depth) + node.raw.trim()
  if (RAW_TEXT_ELEMENTS.has(node.name) || !hasOnlyElementChildren(node)) {
    return INDENT.repeat(depth) + printInline(node)
  }
  const children = node.children.filter((child) => !isBlankText(child)).map((child) => printNode(child, depth + 1))
  return [INDENT.repeat(depth) + node.open, ...children, INDENT.repeat(depth) + (node.close ?? '')].join('\n')
}

export function prettyPrintProjection(html: string): string {
  const tree = buildTree(tokenize(html))
  return tree.filter((node) => !isBlankText(node)).map((node) => printNode(node, 0)).join('\n')
}
