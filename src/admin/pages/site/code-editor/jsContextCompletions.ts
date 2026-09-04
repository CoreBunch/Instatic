/**
 * jsContextCompletions — the God Mode JS panel's completions beyond plain
 * JavaScript, appended to lang-javascript's own sources (never replacing
 * them): inside the string argument of a DOM lookup, the page's real class
 * names and element ids — the selected element's own first.
 *
 *   - `querySelector` / `querySelectorAll` / `closest` / `matches`: `.class`
 *     and `#id` selector tokens (a bare `.` or `#` narrows to one kind);
 *   - `getElementsByClassName` and `classList.add/remove/toggle/contains/
 *     replace`: bare class names;
 *   - `getElementById`: bare ids.
 *
 * Part of the lazy CodeMirror chunk (see codemirror-lazy-only.test.ts).
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from './syntaxNode'
import type { JsCompletionCatalog } from './completionCatalog'

const SELECTOR_METHODS = new Set(['querySelector', 'querySelectorAll', 'closest', 'matches'])
const CLASS_LIST_METHODS = new Set(['add', 'remove', 'toggle', 'contains', 'replace'])
const SELECTOR_TOKEN = /^[\w.#-]*$/

type LookupKind = 'selector' | 'class' | 'id'

/** The DOM lookup whose string argument the cursor is in, if any. */
function lookupKind(state: EditorState, stringNode: SyntaxNode): LookupKind | null {
  const call = stringNode.parent?.name === 'ArgList' ? stringNode.parent.parent : null
  const callee = call?.name === 'CallExpression' ? call.firstChild : null
  if (callee?.name !== 'MemberExpression') return null
  const property = callee.lastChild
  if (property?.name !== 'PropertyName') return null
  const method = state.sliceDoc(property.from, property.to)
  if (SELECTOR_METHODS.has(method)) return 'selector'
  if (method === 'getElementsByClassName') return 'class'
  if (method === 'getElementById') return 'id'
  if (CLASS_LIST_METHODS.has(method)) {
    const receiver = callee.firstChild
    const receiverProperty = receiver?.name === 'MemberExpression' ? receiver.lastChild : null
    if (receiverProperty && state.sliceDoc(receiverProperty.from, receiverProperty.to) === 'classList') return 'class'
  }
  return null
}

function stringNodeAt(node: SyntaxNode): SyntaxNode | null {
  for (let current: SyntaxNode | null = node; current; current = current.parent) {
    if (current.name === 'String' || current.name === 'TemplateString') return current
  }
  return null
}

function nameOptions(names: readonly string[], selected: readonly string[], prefix: string, type: string): Completion[] {
  return names.map((name) => ({
    label: prefix + name,
    type,
    section: selected.includes(name) ? 'Selected element' : 'Page',
    boost: selected.includes(name) ? 1 : 0,
  }))
}

function classOptions(catalog: JsCompletionCatalog, prefix: string): Completion[] {
  return nameOptions(catalog.classes, catalog.selectedClasses, prefix, 'class')
}

function idOptions(catalog: JsCompletionCatalog, prefix: string): Completion[] {
  return nameOptions(catalog.ids, catalog.selectedIds, prefix, 'variable')
}

function selectorCompletions(catalog: JsCompletionCatalog, before: string, pos: number): CompletionResult | null {
  const token = /([.#])([\w-]*)$/.exec(before)
  if (token) {
    const options = token[1] === '.' ? classOptions(catalog, '') : idOptions(catalog, '')
    return { from: pos - token[2].length, to: pos, options, validFor: SELECTOR_TOKEN }
  }
  if (before === '' || /[\s>+~,(]$/.test(before)) {
    return { from: pos, to: pos, options: [...classOptions(catalog, '.'), ...idOptions(catalog, '#')], validFor: SELECTOR_TOKEN }
  }
  return null
}

function wordCompletions(options: Completion[], before: string, pos: number): CompletionResult {
  const word = /[\w-]*$/.exec(before)?.[0] ?? ''
  return { from: pos - word.length, to: pos, options, validFor: SELECTOR_TOKEN }
}

export function jsContextCompletion(getCatalog: () => JsCompletionCatalog | null) {
  return (context: CompletionContext): CompletionResult | null => {
    const catalog = getCatalog()
    if (!catalog) return null
    const { state, pos } = context
    const stringNode = stringNodeAt(syntaxTree(state).resolveInner(pos, -1))
    if (!stringNode || pos <= stringNode.from) return null
    const kind = lookupKind(state, stringNode)
    if (!kind) return null
    // The string's content up to the cursor, past the opening quote.
    const before = state.sliceDoc(stringNode.from + 1, pos)
    switch (kind) {
      case 'selector':
        return selectorCompletions(catalog, before, pos)
      case 'class':
        return wordCompletions(classOptions(catalog, ''), before, pos)
      case 'id':
        return wordCompletions(idOptions(catalog, ''), before, pos)
    }
  }
}
