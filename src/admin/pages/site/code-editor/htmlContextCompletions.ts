/**
 * htmlContextCompletions — the God Mode HTML panel's completions beyond
 * plain HTML, appended to lang-html's own source (never replacing it):
 *
 *   - the projection dialect's `instatic-*` marker tags and, inside one,
 *     its attributes and known attribute values (loop sources, tables,
 *     Visual Components, direction / pagination keywords);
 *   - class names inside a `class` attribute (one word at a time);
 *   - dynamic tokens after `{` in text or any attribute value: `page`,
 *     `site`, `route` fields always, `currentEntry` / `parentEntry` from the
 *     entry frames in scope — the catalog's outer frames plus the
 *     `<instatic-loop>` elements enclosing the cursor, read from the text so
 *     a loop typed a moment ago already completes its own fields.
 *
 * Part of the lazy CodeMirror chunk (see codemirror-lazy-only.test.ts).
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { elementAttribute, enclosingElement, type SyntaxNode } from './syntaxNode'
import { PROJECTION_TAGS, PROJECTION_TAG_ATTRIBUTES, isProjectionTag } from '@core/publisher'
import {
  resolveEntryFields,
  type EntryFrame,
  type HtmlCompletionCatalog,
  type TokenCompletionCatalog,
  type TokenFieldCompletion,
} from './completionCatalog'

const IDENTIFIER = /^[:\-.\w\u00b7-\uffff]*$/
const CLASS_WORD = /^[^\s"'<>]*$/
const TOKEN_PATH = /^[\w.]*$/

function elementTagName(state: EditorState, element: SyntaxNode | null): string {
  const tag = element?.firstChild?.getChild('TagName')
  return tag ? state.sliceDoc(tag.from, tag.to) : ''
}

/** The `<instatic-loop>` elements enclosing `node`, outermost first. */
function enclosingLoopFrames(state: EditorState, node: SyntaxNode): EntryFrame[] {
  const frames: EntryFrame[] = []
  for (let element = enclosingElement(node); element; element = enclosingElement(element.parent)) {
    if (elementTagName(state, element) !== PROJECTION_TAGS.loop) continue
    frames.unshift({
      kind: 'loop',
      sourceId: elementAttribute(state, element, 'data-source-id') || null,
      tableId: elementAttribute(state, element, 'data-table-id') || null,
    })
  }
  return frames
}

function tagCompletions(from: number, to: number, prefix: string): CompletionResult {
  return {
    from,
    to,
    options: Object.values(PROJECTION_TAGS).map((tag) => ({ label: prefix + tag, type: 'type' })),
    validFor: prefix ? /^<\/?[:\-.\w\u00b7-\uffff]*$/ : IDENTIFIER,
  }
}

function attributeNameCompletions(state: EditorState, node: SyntaxNode, from: number, to: number): CompletionResult | null {
  const tagName = elementTagName(state, enclosingElement(node))
  if (!isProjectionTag(tagName)) return null
  return {
    from,
    to,
    options: PROJECTION_TAG_ATTRIBUTES[tagName].map((name) => ({ label: name, type: 'property' })),
    validFor: IDENTIFIER,
  }
}

interface AttributeValueRegion {
  attribute: string
  tagName: string
  /** Start of the value text (after an opening quote). */
  from: number
  /** The value text typed so far, up to the cursor. */
  text: string
  /** What closes the value after an applied completion. */
  quoteEnd: string
  /** The regex a further keystroke must match to keep the list open. */
  validFor: RegExp
}

function attributeValueRegion(state: EditorState, node: SyntaxNode, pos: number): AttributeValueRegion | null {
  const attributeNode = node.name === 'Is' || node.name === 'AttributeValue' || node.name === 'UnquotedAttributeValue'
    ? node.parent
    : null
  const nameNode = attributeNode?.getChild('AttributeName')
  if (!attributeNode || !nameNode) return null
  const attribute = state.sliceDoc(nameNode.from, nameNode.to)
  const tagName = elementTagName(state, enclosingElement(attributeNode))
  if (node.name === 'Is') {
    return { attribute, tagName, from: pos, text: '', quoteEnd: '"', validFor: /^[^\s<>='"]*$/ }
  }
  let from = node.from
  let text = state.sliceDoc(from, pos)
  let quoteEnd = ''
  let validFor = /^[^\s<>='"]*$/
  if (/^['"]/.test(text)) {
    const quote = text[0]
    validFor = quote === '"' ? /^[^"]*$/ : /^[^']*$/
    quoteEnd = state.sliceDoc(pos, pos + 1) === quote ? '' : quote
    text = text.slice(1)
    from++
  }
  return { attribute, tagName, from, text, quoteEnd, validFor }
}

function classAttributeCompletions(catalog: HtmlCompletionCatalog, region: AttributeValueRegion, pos: number): CompletionResult {
  const word = /[^\s]*$/.exec(region.text)?.[0] ?? ''
  return {
    from: pos - word.length,
    to: pos,
    // Author classes rank above the (many, alphabetically early) framework
    // utilities; both stay assignable.
    options: catalog.classes.map((cls) => ({
      label: cls.name,
      type: 'class',
      detail: cls.generated ? 'framework utility' : `used by ${cls.usage}`,
      boost: cls.generated ? -1 : 0,
    })),
    validFor: CLASS_WORD,
  }
}

function dialectValueOptions(catalog: HtmlCompletionCatalog, region: AttributeValueRegion): Completion[] | null {
  if (!isProjectionTag(region.tagName)) return null
  switch (region.attribute) {
    case 'data-source-id':
      return Object.entries(catalog.tokens.loopSources).map(([id, source]) => ({ label: id, detail: source.label, type: 'constant' }))
    case 'data-table-id':
      return catalog.tokens.tables.map((table) => ({ label: table.id, detail: table.name, type: 'constant' }))
    case 'data-component-id':
      return catalog.components.map((vc) => ({ label: vc.id, detail: vc.name, type: 'constant' }))
    case 'data-direction':
      return [{ label: 'desc', type: 'constant' }, { label: 'asc', type: 'constant' }]
    case 'data-pagination':
      return [{ label: 'infinite', type: 'constant' }]
    default:
      return null
  }
}

function dialectValueCompletions(catalog: HtmlCompletionCatalog, region: AttributeValueRegion, pos: number): CompletionResult | null {
  const options = dialectValueOptions(catalog, region)
  if (!options) return null
  return {
    from: region.from,
    to: pos,
    options: options.map((option) => ({ ...option, apply: option.label + region.quoteEnd })),
    validFor: region.validFor,
  }
}

function tokenOptions(source: string, section: string, fields: readonly TokenFieldCompletion[], boost: number, close: string): Completion[] {
  return fields.map((field) => ({
    label: `${source}.${field.id}`,
    detail: field.label,
    type: 'property',
    section,
    boost,
    apply: `${source}.${field.id}${close}`,
  }))
}

/** `{` … cursor, with a token path typed so far — or null when not in a token. */
function tokenRegion(state: EditorState, node: SyntaxNode, pos: number): { from: number; path: string } | null {
  const inText = node.name === 'Text' || node.name === 'AttributeValue' || node.name === 'UnquotedAttributeValue'
  if (!inText) return null
  const before = state.sliceDoc(node.from, pos)
  const open = before.lastIndexOf('{')
  if (open < 0 || (open > 0 && before[open - 1] === '\\')) return null
  const path = before.slice(open + 1)
  return TOKEN_PATH.test(path) ? { from: node.from + open + 1, path } : null
}

function tokenCompletions(tokens: TokenCompletionCatalog, state: EditorState, node: SyntaxNode, pos: number): CompletionResult | null {
  const region = tokenRegion(state, node, pos)
  if (!region) return null
  const close = state.sliceDoc(pos, pos + 1) === '}' ? '' : '}'
  const entries = resolveEntryFields(tokens, enclosingLoopFrames(state, node))
  const options: Completion[] = []
  if (entries.currentEntry) options.push(...tokenOptions('currentEntry', 'Current entry', entries.currentEntry, 2, close))
  if (entries.parentEntry) options.push(...tokenOptions('parentEntry', 'Parent entry', entries.parentEntry, 1, close))
  for (const source of tokens.systemSources) {
    options.push(...tokenOptions(source.id, source.label, source.fields, 0, close))
  }
  return { from: region.from, to: pos, options, validFor: TOKEN_PATH }
}

export function htmlContextCompletion(getCatalog: () => HtmlCompletionCatalog | null) {
  return (context: CompletionContext): CompletionResult | null => {
    const catalog = getCatalog()
    if (!catalog) return null
    const { state, pos } = context
    const node = syntaxTree(state).resolveInner(pos, -1)

    const token = tokenCompletions(catalog.tokens, state, node, pos)
    if (token) return token

    switch (node.name) {
      case 'TagName':
        return node.parent && /CloseTag$/.test(node.parent.name) ? null : tagCompletions(node.from, pos, '')
      case 'StartTag':
      case 'IncompleteTag':
        return tagCompletions(pos, pos, '')
      case 'OpenTag':
      case 'SelfClosingTag':
        return attributeNameCompletions(state, node, pos, pos)
      case 'AttributeName':
        return attributeNameCompletions(state, node, node.from, pos)
      case 'Is':
      case 'AttributeValue':
      case 'UnquotedAttributeValue': {
        const region = attributeValueRegion(state, node, pos)
        if (!region) return null
        if (region.attribute === 'class') return classAttributeCompletions(catalog, region, pos)
        return dialectValueCompletions(catalog, region, pos)
      }
      default:
        break
    }
    if (context.explicit && (node.name === 'Element' || node.name === 'Text' || node.name === 'Document')) {
      return tagCompletions(pos, pos, '<')
    }
    return null
  }
}
