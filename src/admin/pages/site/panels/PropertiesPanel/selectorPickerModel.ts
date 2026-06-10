import { styleRuleSelector, type PageNode, type StyleRule } from '@core/page-tree'
import { readIdentifierEnd, splitSelectorList, stripStatePseudos } from '@site/cssStatePseudo'

export type SelectorMatch =
  | { kind: 'direct' }
  | { kind: 'inactive-pseudo'; pseudo: string }

export interface SelectorPillItem {
  rule: StyleRule
  match: SelectorMatch
  active: boolean
  removable: boolean
}

export interface SelectorSuggestionItem {
  rule: StyleRule
  disabled: boolean
  disabledReason: string | null
  match: SelectorMatch | null
}

export interface SelectorPickerModelInput {
  rules: Record<string, StyleRule>
  node: PageNode | null
  selectedElement: Element | null
  activeRuleId: string | null
}

export interface SelectorPickerModel {
  pills: SelectorPillItem[]
  suggestions: SelectorSuggestionItem[]
}

export function deriveSelectorPickerModel(input: SelectorPickerModelInput): SelectorPickerModel {
  const { rules, node, selectedElement, activeRuleId } = input
  const assignedIds = node?.classIds ?? []
  const assignedIdSet = new Set(assignedIds)
  const selectorSubject = authorSelectorSubject(selectedElement)
  const pills: SelectorPillItem[] = []
  const suggestions: SelectorSuggestionItem[] = []

  for (const classId of assignedIds) {
    const rule = rules[classId]
    if (!rule || rule.kind === 'ambient') continue
    pills.push({
      rule,
      match: { kind: 'direct' },
      active: activeRuleId === rule.id,
      removable: true,
    })
  }

  for (const rule of sortedRules(rules)) {
    if (rule.kind === 'ambient') {
      const { match, pillMatch } = evaluateAmbientRule(rule, selectorSubject)
      if (pillMatch) {
        pills.push({
          rule,
          match: pillMatch,
          active: activeRuleId === rule.id,
          removable: false,
        })
      }
      suggestions.push({
        rule,
        match,
        disabled: match === null,
        disabledReason: match === null ? "Doesn't match this element" : null,
      })
      continue
    }

    if (!assignedIdSet.has(rule.id)) {
      suggestions.push({
        rule,
        match: null,
        disabled: false,
        disabledReason: null,
      })
    }
  }

  return { pills: sortPillsBySpecificity(pills), suggestions }
}

const CANVAS_NODE_EDITOR_ATTRS = new Set([
  'data-node-id',
  'data-module-id',
  'data-hovered',
  'tabindex',
  'role',
  'aria-pressed',
])

/**
 * Ambient selector chips should describe author-visible markup, not canvas
 * selection plumbing. Clone the selected element's document body so structural
 * selectors (`.hero > .image`, `:first-child`, siblings) still evaluate, then
 * strip editor-only attrs from canvas node roots before calling `matches()`.
 */
function authorSelectorSubject(selectedElement: Element | null): Element | null {
  if (!selectedElement) return null
  const nodeId = selectedElement.getAttribute('data-node-id')
  if (!nodeId) return selectedElement

  const body = selectedElement.ownerDocument.body
  const root = body?.cloneNode(true) as HTMLElement | null
  if (!root) return selectedElement

  const subject = findCanvasNodeClone(root, nodeId)
  if (!subject) return selectedElement

  stripCanvasEditorAttributes(root)
  return subject
}

function findCanvasNodeClone(root: Element, nodeId: string): Element | null {
  if (root.getAttribute('data-node-id') === nodeId) return root
  for (const element of root.querySelectorAll('[data-node-id]')) {
    if (element.getAttribute('data-node-id') === nodeId) return element
  }
  return null
}

function stripCanvasEditorAttributes(root: Element): void {
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const isCanvasNodeRoot = element.hasAttribute('data-node-id')
    for (const attr of Array.from(element.attributes)) {
      if (attr.name.startsWith('data-canvas-') || (isCanvasNodeRoot && CANVAS_NODE_EDITOR_ATTRS.has(attr.name))) {
        element.removeAttribute(attr.name)
      }
    }
  }
}

function sortedRules(rules: Record<string, StyleRule>): StyleRule[] {
  return Object.values(rules).slice().sort((a, b) => {
    const byOrder = normaliseOrder(a) - normaliseOrder(b)
    return byOrder !== 0 ? byOrder : a.name.localeCompare(b.name)
  })
}

function normaliseOrder(rule: StyleRule): number {
  return Number.isFinite(rule.order) ? rule.order : 0
}

/**
 * Order pills weakest → strongest by CSS specificity, so the chip that actually
 * wins the cascade reads last (e.g. `*` → `.btn-primary` → `.btn-primary:hover`).
 * Equal specificity falls back to stylesheet source order, then name, for a
 * stable result.
 */
function sortPillsBySpecificity(pills: SelectorPillItem[]): SelectorPillItem[] {
  return pills
    .map((pill) => ({ pill, specificity: selectorSpecificity(styleRuleSelector(pill.rule)) }))
    .sort((a, b) => {
      const bySpecificity = compareSpecificity(a.specificity, b.specificity)
      if (bySpecificity !== 0) return bySpecificity
      const byOrder = normaliseOrder(a.pill.rule) - normaliseOrder(b.pill.rule)
      if (byOrder !== 0) return byOrder
      return a.pill.rule.name.localeCompare(b.pill.rule.name)
    })
    .map((entry) => entry.pill)
}

type Specificity = readonly [number, number, number]

function compareSpecificity(a: Specificity, b: Specificity): number {
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])
}

/**
 * Pragmatic CSS specificity `(ids, classes, types)` for a selector, used purely
 * to order pills:
 *   - ids:     `#id`
 *   - classes: `.class`, `[attr]`, and `:pseudo-class` (`:where()` counts 0)
 *   - types:   element names and `::pseudo-element`
 * The universal `*` and combinators count nothing. For a selector list the
 * strongest comma-separated part wins. Functional-pseudo arguments
 * (`:not()`/`:is()`/`:has()`) are not recursed into — exact cascade weight isn't
 * needed for ordering, so the simpler count is intentional.
 */
function selectorSpecificity(selector: string): Specificity {
  let strongest: Specificity = [0, 0, 0]
  for (const part of splitSelectorList(selector)) {
    const partSpecificity = compoundSpecificity(part)
    if (compareSpecificity(partSpecificity, strongest) > 0) strongest = partSpecificity
  }
  return strongest
}

const IDENTIFIER_CHAR = /[\w-]/

function compoundSpecificity(selector: string): Specificity {
  let ids = 0
  let classes = 0
  let types = 0
  let i = 0
  while (i < selector.length) {
    const ch = selector[i]
    if (ch === '[' || ch === '(') {
      // Attribute selectors count as a class; pseudo arguments are skipped.
      if (ch === '[') classes++
      i = skipBalanced(selector, i)
      continue
    }
    if (ch === '#') {
      ids++
      i = readIdentifierEnd(selector, i + 1)
      continue
    }
    if (ch === '.') {
      classes++
      i = readIdentifierEnd(selector, i + 1)
      continue
    }
    if (ch === ':') {
      if (selector[i + 1] === ':') {
        types++ // pseudo-element
        i = readIdentifierEnd(selector, i + 2)
        continue
      }
      const end = readIdentifierEnd(selector, i + 1)
      if (selector.slice(i + 1, end) !== 'where') classes++ // `:where()` is always 0
      i = end
      continue
    }
    if (IDENTIFIER_CHAR.test(ch)) {
      types++ // element/type selector
      i = readIdentifierEnd(selector, i + 1)
      continue
    }
    // `*`, combinators, and whitespace contribute nothing.
    i++
  }
  return [ids, classes, types]
}

/** Skip from an opening `(`/`[` to just past its matching close, depth-aware. */
function skipBalanced(selector: string, start: number): number {
  const open = selector[start]
  const close = open === '(' ? ')' : ']'
  let depth = 0
  let i = start
  while (i < selector.length) {
    const ch = selector[i]
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return i
}

interface AmbientRuleEvaluation {
  /** Strongest match across all selector-list entries — drives suggestions. */
  match: SelectorMatch | null
  /**
   * Strongest match among entries that target the element *specifically* —
   * drives pills. `null` when the rule only matches through universal-subject
   * entries (`*`, `body.x *`, `*::before`, …): those rules style every element
   * in their scope — page-wide resets imported from external stylesheets —
   * so they are not an identity of the selected element and must not surface
   * as pills. They stay editable through the suggestions dropdown and the
   * Selectors panel.
   */
  pillMatch: SelectorMatch | null
}

function evaluateAmbientRule(rule: StyleRule, selectedElement: Element | null): AmbientRuleEvaluation {
  if (!selectedElement) return { match: null, pillMatch: null }

  let match: SelectorMatch | null = null
  let pillMatch: SelectorMatch | null = null
  // Each comma-separated entry is evaluated independently: it may match
  // directly, or target the element in an interactive pseudo-state
  // (`:hover`/`:focus`/…) that is off while editing — those still surface as
  // inactive-pseudo matches so the state styles stay editable. The state
  // pseudo may sit alongside a `::pseudo-element` (`.card:hover::after`), so
  // entries are re-tested after stripping state pseudos and pseudo-elements.
  for (const entry of splitSelectorList(styleRuleSelector(rule))) {
    let entryMatch: SelectorMatch | null = null
    if (safeMatches(selectedElement, entry)) {
      entryMatch = { kind: 'direct' }
    } else {
      const { base, pseudo } = stripStatePseudos(entry)
      if (pseudo && base && safeMatches(selectedElement, base)) {
        entryMatch = { kind: 'inactive-pseudo', pseudo }
      }
    }
    if (!entryMatch) continue
    match = preferMatch(match, entryMatch)
    if (isSpecificSubject(subjectCompound(entry))) {
      pillMatch = preferMatch(pillMatch, entryMatch)
    }
  }
  return { match, pillMatch }
}

/** A direct match beats an inactive-pseudo match; otherwise first wins. */
function preferMatch(current: SelectorMatch | null, next: SelectorMatch): SelectorMatch {
  if (!current) return next
  if (current.kind === 'direct') return current
  return next.kind === 'direct' ? next : current
}

/**
 * The subject (rightmost compound) of a single complex selector — the part
 * after the last top-level combinator. Combinator characters inside `()`/`[]`
 * or quoted strings (e.g. `[class~="x"]`, `:not(a > b)`) don't split.
 */
function subjectCompound(selectorPart: string): string {
  let subjectStart = 0
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let i = 0; i < selectorPart.length; i++) {
    const ch = selectorPart[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[') {
      depth++
      continue
    }
    if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '>' || ch === '+' || ch === '~')) {
      subjectStart = i + 1
    }
  }
  return selectorPart.slice(subjectStart).trim()
}

/**
 * Whether a subject compound narrows the match beyond "every element": it
 * contains at least one type, class, id, or attribute simple selector. A
 * compound made only of `*` and pseudos (`*`, `*::before`, `:hover`) matches
 * every element in its scope — a reset, not an element identity.
 */
function isSpecificSubject(compound: string): boolean {
  let i = 0
  while (i < compound.length) {
    const ch = compound[i]
    if (ch === '*') {
      i++
      continue
    }
    if (ch === ':') {
      // Pseudo-class/element — skip the name and any `(...)` arguments.
      i = readIdentifierEnd(compound, compound[i + 1] === ':' ? i + 2 : i + 1)
      if (compound[i] === '(') i = skipBalanced(compound, i)
      continue
    }
    // Type, class, id, or attribute selector — narrows the match.
    return true
  }
  return false
}

function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector)
  } catch (_err) {
    // Corrupt persisted selectors must not break the Properties panel render path.
    return false
  }
}
