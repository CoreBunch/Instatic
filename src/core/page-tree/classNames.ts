import type { StyleRule } from './styleRule'

export type StyleRuleRegistry = Record<string, StyleRule> | null | undefined

const ASCII_WHITESPACE_RE = /[\t\n\f\r ]/
// Class names cannot contain ASCII control characters. The regex literally
// matches the U+0000–U+001F + U+007F range, which is precisely the rule we
// want to enforce; the `no-control-regex` lint rule exists to flag accidental
// uses, which this is not.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\0-\x1f\x7f]/

function validateCssClassName(name: string): string | null {
  if (name.length === 0) return 'Class name is required'
  if (name.trim() !== name) return 'Class names cannot start or end with whitespace'
  if (ASCII_WHITESPACE_RE.test(name)) return 'Class names cannot contain whitespace'
  if (CONTROL_CHAR_RE.test(name)) return 'Class names cannot contain control characters'
  return null
}

export function assertValidCssClassName(name: string): void {
  const error = validateCssClassName(name)
  if (error) throw new Error(`[classSlice] ${error}`)
}

/**
 * Return the CSS selector to emit for a style rule.
 *
 *   - kind:'class':   `rule.selector` (a canonical `.<escaped-name>` or a
 *                     preserved imported selector containing that class).
 *   - kind:'ambient': `rule.selector` verbatim (`h1 > span`, `a:hover`, ...).
 */
export function styleRuleSelector(cls: Pick<StyleRule, 'selector'>): string {
  return cls.selector
}

function classNameForClassId(
  classes: StyleRuleRegistry,
  classId: string,
): string | null {
  const cls = classes?.[classId]
  if (!cls) return null
  // Only class-kind rules contribute a token to the node's `class=` attribute.
  // Ambient rules attach by selector matching, not by a class-attribute token.
  if (cls.kind !== 'class') return null
  return cls.name
}

/**
 * Resolve a node's `classIds` to the class-attribute tokens the publisher
 * should write. Ambient-kind rules are silently filtered out — they never
 * belong in `class="..."`. Unknown ids are also dropped.
 */
export function classNamesForClassIds(
  classes: StyleRuleRegistry,
  classIds: readonly string[] | undefined,
): string[] {
  if (!classes || !classIds?.length) return []

  const names: string[] = []
  for (const id of classIds) {
    const name = classNameForClassId(classes, id)
    if (name) names.push(name)
  }
  return names
}
