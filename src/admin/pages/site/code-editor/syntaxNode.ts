/**
 * The lezer syntax-node type the HTML context sources walk (it is not
 * re-exported by @codemirror/language), and the two walks they share over
 * the HTML grammar: the nearest enclosing element, and one of its open-tag
 * attributes.
 *
 * Part of the lazy CodeMirror chunk (see codemirror-lazy-only.test.ts).
 */
import type { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

export type SyntaxNode = ReturnType<typeof syntaxTree>['topNode']

/** The nearest `Element` at or above `node`. */
export function enclosingElement(node: SyntaxNode | null): SyntaxNode | null {
  for (let current = node; current; current = current.parent) {
    if (current.name === 'Element') return current
  }
  return null
}

/**
 * The value of `name` on `element`'s open tag, quotes stripped: `''` when
 * the attribute is present without a value, null when absent.
 */
export function elementAttribute(state: EditorState, element: SyntaxNode, name: string): string | null {
  const openTag = element.firstChild
  if (!openTag || (openTag.name !== 'OpenTag' && openTag.name !== 'SelfClosingTag')) return null
  for (const attribute of openTag.getChildren('Attribute')) {
    const nameNode = attribute.getChild('AttributeName')
    if (!nameNode || state.sliceDoc(nameNode.from, nameNode.to) !== name) continue
    const valueNode = attribute.getChild('AttributeValue') ?? attribute.getChild('UnquotedAttributeValue')
    return valueNode ? state.sliceDoc(valueNode.from, valueNode.to).replace(/^["']|["']$/g, '') : ''
  }
  return null
}
