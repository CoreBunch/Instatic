/**
 * Style-rule closure for `extractFragment`: framework stubs, keyframes the
 * carried declarations animate with, ancestor-only selector dependencies, and
 * the conditions carried rules key on.
 */

import {
  extractCssSelectorClasses,
  splitCssSelectorList,
  type ConditionDef,
  type Page,
  type StyleRule,
} from '@core/page-tree'
import { FRAMEWORK_ID_PREFIX } from '@core/framework'
import type { FragmentOutsideDependency } from './schema'

const KEYFRAMES_PREFIX = '@keyframes '

// ---------------------------------------------------------------------------
// 3–4. Rules
// ---------------------------------------------------------------------------

/** A framework utility, carried by name: the target regenerates its styles. */
export function frameworkStub(rule: StyleRule): StyleRule {
  const { stylePriorities: _stylePriorities, contextStylePriorities: _contextStylePriorities, ...rest } = rule
  return { ...structuredClone(rest), styles: {}, contextStyles: {} }
}

/** Carry each `@keyframes` block a carried declaration animates with. */
export function carryKeyframes(all: Record<string, StyleRule>, carried: Map<string, StyleRule>): void {
  const keyframes = Object.values(all).filter(
    (rule) => rule.kind === 'ambient' && rule.selector.startsWith(KEYFRAMES_PREFIX),
  )
  if (keyframes.length === 0) return
  const animationText: string[] = []
  for (const rule of carried.values()) {
    for (const bag of [rule.styles, ...Object.values(rule.contextStyles)]) {
      for (const [property, value] of Object.entries(bag)) {
        if (/^animation(Name)?$/.test(property) && typeof value === 'string') animationText.push(value)
      }
    }
  }
  const words = new Set(animationText.join(' ').split(/[\s,]+/))
  for (const rule of keyframes) {
    const name = rule.selector.slice(KEYFRAMES_PREFIX.length).trim()
    if (words.has(name) && !carried.has(rule.id)) carried.set(rule.id, structuredClone(rule))
  }
}

/**
 * Rules that style the selection through a class only its ANCESTORS carry
 * (a page wrapper, the body's site class). A rule counts when it is carried
 * anyway, or when the rightmost compound of one of its selectors could match
 * inside the selection: it names no class (`.wrap h2`), or names a class the
 * selection uses (`.dark .title`).
 */
export function findOutsideDependencies(
  page: Page,
  roots: string[],
  rules: Record<string, StyleRule>,
  carried: Map<string, StyleRule>,
  selectionClassNames: Set<string>,
): FragmentOutsideDependency[] {
  const parentOf = new Map<string, string>()
  for (const node of Object.values(page.nodes)) {
    for (const childId of node.children) parentOf.set(childId, node.id)
  }
  const ancestorClassNames = new Set<string>()
  for (const rootId of roots) {
    let current = parentOf.get(rootId)
    const seen = new Set<string>()
    while (current && !seen.has(current)) {
      seen.add(current)
      for (const classId of page.nodes[current]?.classIds ?? []) {
        const name = rules[classId]?.name
        if (name && !selectionClassNames.has(name)) ancestorClassNames.add(name)
      }
      current = parentOf.get(current)
    }
  }
  if (ancestorClassNames.size === 0) return []

  const out: FragmentOutsideDependency[] = []
  const seenSelectors = new Set<string>()
  for (const rule of Object.values(rules).sort((a, b) => a.order - b.order)) {
    if (rule.id.startsWith(FRAMEWORK_ID_PREFIX) || seenSelectors.has(rule.selector)) continue
    const deps = [...new Set(
      extractCssSelectorClasses(rule.selector).map((t) => t.name).filter((name) => ancestorClassNames.has(name)),
    )]
    if (deps.length === 0) continue
    const relevant = carried.has(rule.id) || splitCssSelectorList(rule.selector).some((part) => {
      const last = extractCssSelectorClasses(lastCompound(part)).map((t) => t.name)
      return last.length === 0 || last.some((name) => selectionClassNames.has(name))
    })
    if (!relevant) continue
    seenSelectors.add(rule.selector)
    out.push({ selector: rule.selector, classes: deps.sort() })
  }
  return out
}

/** The rightmost compound selector of one complex selector. */
function lastCompound(selector: string): string {
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (depth === 0 && (char === ' ' || char === '>' || char === '+' || char === '~')) start = index + 1
  }
  return selector.slice(start).trim()
}

// ---------------------------------------------------------------------------
// 5. Conditions
// ---------------------------------------------------------------------------

export function collectConditions(
  rules: StyleRule[],
  breakpointIds: string[],
  defs: ConditionDef[],
): ConditionDef[] {
  const viewport = new Set(breakpointIds)
  const used = new Set<string>()
  for (const rule of rules) {
    for (const key of Object.keys(rule.contextStyles)) if (!viewport.has(key)) used.add(key)
    for (const key of Object.keys(rule.contextStylePriorities ?? {})) if (!viewport.has(key)) used.add(key)
  }
  return defs.filter((def) => used.has(def.id)).map((def) => structuredClone(def))
}
