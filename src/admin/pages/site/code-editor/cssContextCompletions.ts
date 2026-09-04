/**
 * cssContextCompletions — the God Mode CSS panel's completions beyond plain
 * CSS, appended to lang-css's own source (never replacing it):
 *
 *   - inside `var(…)`: every custom property that exists on the published
 *     site (framework tokens, then author-declared properties from style
 *     rules and style assets). Properties the current document itself
 *     declares are left to lang-css, which already lists those. A bare
 *     `--name` typed as a value gets the same list, completing to the full
 *     `var(--name)` reference.
 *   - after `.` in a selector: the site's editable class names, with their
 *     site-wide usage.
 *
 * Part of the lazy CodeMirror chunk (see codemirror-lazy-only.test.ts).
 */
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from './syntaxNode'
import type { CssCompletionCatalog } from './completionCatalog'

const VARIABLE = /^-(-[\w-]*)?$/
const CLASS_IDENTIFIER = /^[\w-]*$/
/** `var(` up to the cursor, through any partial `-`/`--name` typed after it. */
const VAR_ARGUMENT_BEFORE_CURSOR = /var\(\s*(-{0,2}[\w-]*)$/
const DECLARED_PROPERTY = /(?:^|[{;\s])(--[\w-]+)\s*:/g

const ORIGIN_SECTION: Record<CssCompletionCatalog['customProperties'][number]['origin'], string> = {
  framework: 'Framework tokens',
  rule: 'Style rules',
  asset: 'Style assets',
}

function declarationStart(state: EditorState, node: SyntaxNode, pos: number): number {
  for (let current: SyntaxNode | null = node; current; current = current.parent) {
    if (current.name === 'Declaration') return current.from
  }
  return state.doc.lineAt(pos).from
}

function documentDeclaredProperties(state: EditorState): Set<string> {
  const declared = new Set<string>()
  for (const match of state.doc.toString().matchAll(DECLARED_PROPERTY)) declared.add(match[1])
  return declared
}

/**
 * A bare `--name` typed as a declaration VALUE (after the colon, outside
 * `var()`): completing it writes the full `var(--name)` reference.
 */
function bareValueCustomProperty(node: SyntaxNode): boolean {
  return node.name === 'VariableName' && node.parent?.name === 'Declaration' && node.prevSibling !== null
}

function customPropertyOptions(catalog: CssCompletionCatalog, state: EditorState, wrapInVar: boolean) {
  const declared = documentDeclaredProperties(state)
  return catalog.customProperties
    .filter((property) => !declared.has(property.name))
    .map((property) => ({
      label: property.name,
      detail: property.value ?? property.declaredIn,
      info: property.declaredIn,
      type: 'variable',
      section: ORIGIN_SECTION[property.origin],
      ...(wrapInVar ? { apply: `var(${property.name})` } : {}),
    }))
}

function customPropertyCompletions(catalog: CssCompletionCatalog, state: EditorState, node: SyntaxNode, pos: number): CompletionResult | null {
  const before = state.sliceDoc(declarationStart(state, node, pos), pos)
  const match = VAR_ARGUMENT_BEFORE_CURSOR.exec(before)
  if (match) {
    return { from: pos - match[1].length, to: pos, options: customPropertyOptions(catalog, state, false), validFor: VARIABLE }
  }
  if (bareValueCustomProperty(node)) {
    return { from: node.from, to: pos, options: customPropertyOptions(catalog, state, true), validFor: VARIABLE }
  }
  return null
}

function classSelectorCompletions(catalog: CssCompletionCatalog, node: SyntaxNode, pos: number): CompletionResult | null {
  if (node.parent?.name !== 'ClassSelector') return null
  const from = node.name === 'ClassName' ? node.from : node.name === '.' ? pos : null
  if (from === null) return null
  return {
    from,
    to: pos,
    options: catalog.classes.map((cls) => ({ label: cls.name, detail: `used by ${cls.usage}`, type: 'class' })),
    validFor: CLASS_IDENTIFIER,
  }
}

export function cssContextCompletion(getCatalog: () => CssCompletionCatalog | null) {
  return (context: CompletionContext): CompletionResult | null => {
    const catalog = getCatalog()
    if (!catalog) return null
    const { state, pos } = context
    const node = syntaxTree(state).resolveInner(pos, -1)
    return customPropertyCompletions(catalog, state, node, pos) ?? classSelectorCompletions(catalog, node, pos)
  }
}
