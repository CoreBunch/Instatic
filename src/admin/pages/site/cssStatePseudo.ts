/**
 * Shared helpers for reasoning about CSS *state* pseudo-classes in the editor.
 *
 * A state pseudo (`:hover`, `:focus`, `:checked`, …) describes a transient
 * interaction, navigation, or input state that is off — or not meaningfully
 * evaluable — while editing. Two editor features depend on recognising them:
 *   - the selector picker, which surfaces such rules as inactive-state pills
 *     even though `Element.matches()` reports a false negative for them, and
 *   - the canvas, which force-previews the state's styles onto the selected
 *     element so you can see/edit it without physically triggering the state.
 */

/**
 * Pseudo-classes describing a transient interaction, navigation, or input state
 * that is off — or not meaningfully evaluable — while editing.
 *
 * Structural and attribute-condition pseudos (`:first-child`, `:nth-child`,
 * `:required`, `:read-only`, `:enabled`, `:link`, `:not()`, …) are intentionally
 * absent: `Element.matches()` evaluates those correctly against the static DOM,
 * so treating them as states would invent false matches. All entries are
 * argument-less; argument-bearing pseudos are never stripped (see
 * `stripStatePseudos`).
 */
const SUPPORTED_PSEUDO_STATES = [
  // Pointer / keyboard interaction — never active while the panel has focus.
  ':hover', ':active', ':focus', ':focus-visible', ':focus-within',
  // Navigation — not applicable inside the editing canvas.
  ':target', ':visited',
  // Form value & validation — a static render shows one state, but the rule
  // styles the other (e.g. the `:checked` look of a currently-unchecked toggle).
  ':checked', ':indeterminate', ':placeholder-shown', ':autofill', ':disabled',
  ':valid', ':invalid', ':in-range', ':out-of-range', ':user-valid', ':user-invalid',
] as const
const SUPPORTED_PSEUDO_SET = new Set<string>(SUPPORTED_PSEUDO_STATES)

/** Split a selector list on top-level commas, ignoring commas inside `()`/`[]`. */
export function splitSelectorList(selector: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(selector.slice(start, i))
      start = i + 1
    }
  }
  parts.push(selector.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

/**
 * Remove supported state pseudo-classes (`:hover`, …) and every pseudo-element
 * (`::before`, …) from a single selector (no top-level commas). Returns the
 * remaining base selector plus the first state pseudo found — or `pseudo: null`
 * when the selector carries no supported state. Pseudo-elements are always
 * dropped because `Element.matches` never matches one.
 */
export function stripStatePseudos(selector: string): { base: string; pseudo: string | null } {
  let base = ''
  let pseudo: string | null = null
  let depth = 0
  let i = 0
  while (i < selector.length) {
    const ch = selector[i]
    if (ch === '(' || ch === '[') {
      depth++
      base += ch
      i++
      continue
    }
    if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1)
      base += ch
      i++
      continue
    }
    if (depth === 0 && ch === ':') {
      if (selector[i + 1] === ':') {
        // Pseudo-element (`::name`) — drop it entirely.
        i = readIdentifierEnd(selector, i + 2)
        continue
      }
      const end = readIdentifierEnd(selector, i + 1)
      const name = selector.slice(i, end)
      // Drop supported, argument-less state pseudos; keep everything else
      // (`:nth-child(2)`, `:first-child`, `:not(...)`) verbatim.
      if (SUPPORTED_PSEUDO_SET.has(name) && selector[end] !== '(') {
        if (!pseudo) pseudo = name
        i = end
        continue
      }
    }
    base += ch
    i++
  }
  return { base: base.trim(), pseudo }
}

/**
 * The first supported state pseudo carried by a selector (in any list entry), or
 * `null` if it carries none. Used to decide whether a rule is a "state" rule.
 */
export function selectorStatePseudo(selector: string): string | null {
  for (const alternative of splitSelectorList(selector)) {
    const { pseudo } = stripStatePseudos(alternative)
    if (pseudo) return pseudo
  }
  return null
}

/** Advance past a CSS identifier (`[A-Za-z0-9_-]`) starting at `start`. */
export function readIdentifierEnd(selector: string, start: number): number {
  let i = start
  while (i < selector.length && /[\w-]/.test(selector[i])) i++
  return i
}
