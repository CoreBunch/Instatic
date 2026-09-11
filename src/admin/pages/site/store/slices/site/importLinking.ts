/**
 * Shared name→id linking utilities for HTML import operations.
 *
 * Extracted so both `insertImportedNodes` (single-page fragment insert) and
 * `mutateAllPagesAndSite` (whole-site Super Import) share the same canonical
 * algorithm without duplication.
 */

import { nanoid } from 'nanoid'
import { classKindSelector } from '@core/page-tree'
import type { StyleRule, StyleRuleOrigin } from '@core/page-tree'
import type { NewStyleRule } from '@core/siteImport'

export type StyleRuleOrderAllocator = () => number

/**
 * Allocate monotonically increasing cascade positions for one import
 * transaction. The existing registry is scanned once; every subsequent rule
 * append is O(1), even when a stylesheet contains tens of thousands of rules.
 */
export function createStyleRuleOrderAllocator(
  rules: Record<string, StyleRule>,
): StyleRuleOrderAllocator {
  let nextOrder = 0
  for (const rule of Object.values(rules)) {
    if (typeof rule.order === 'number' && rule.order >= nextOrder) {
      nextOrder = rule.order + 1
    }
  }
  return () => nextOrder++
}

/**
 * Index a StyleRule registry by name → id.
 * First id wins on duplicates (createClass enforces name uniqueness, so
 * duplicates only occur in corrupted data — first-wins is a defensive tiebreak).
 */
export function indexStyleRulesByName(rules: Record<string, StyleRule>): Map<string, string> {
  const byName = new Map<string, string>()
  for (const cls of Object.values(rules)) {
    if (!byName.has(cls.name)) byName.set(cls.name, cls.id)
  }
  return byName
}

/**
 * The identity a re-import reconciles against: import origin (stylesheet +
 * ordinal) AND selector. Origin alone is not unique in the registry — a class
 * rule the user let the Conflicts step rename (`hero` → `hero-2`) keeps the
 * origin of the rule it was renamed from — so the selector is part of the key
 * rather than a check applied after a lookup that could land on either.
 */
function reimportKey(origin: StyleRuleOrigin, selector: string): string {
  return `${origin.source}\u0000${origin.ordinal}\u0000${selector}`
}

/**
 * Index a StyleRule registry by re-import identity. Rules without an origin —
 * user-authored, or pasted `<style>` CSS — are not indexed and can never be
 * matched by a re-import.
 */
export function indexStyleRulesByOrigin(rules: Record<string, StyleRule>): Map<string, StyleRule> {
  const byOrigin = new Map<string, StyleRule>()
  for (const rule of Object.values(rules)) {
    if (rule.origin) byOrigin.set(reimportKey(rule.origin, rule.selector), rule)
  }
  return byOrigin
}

/**
 * The registry rule that `incoming` is delivering AGAIN: the same import origin
 * AND the same selector. Origin alone is not enough — a stylesheet that gained
 * a rule shifts every later ordinal, and those must arrive as new rules rather
 * than overwrite unrelated ones. Selector alone is not enough either: a sheet
 * may declare one selector several times, and a user-authored `body {}` must
 * survive an import of a theme that also styles `body`.
 *
 * Both import paths — the whole-site wizard (`mutateAllPagesAndSite`) and the
 * single-fragment paste (`mergeImportedStyleRules`) — decide identity here.
 */
export function findReimportedStyleRule(
  byOrigin: ReadonlyMap<string, StyleRule>,
  incoming: NewStyleRule,
): StyleRule | undefined {
  if (!incoming.origin) return undefined
  return byOrigin.get(reimportKey(incoming.origin, incoming.selector))
}

/**
 * Register a freshly committed rule in the identity index so a later rule in
 * the same transaction (or the next import) can find it.
 */
export function registerStyleRuleOrigin(byOrigin: Map<string, StyleRule>, rule: StyleRule): void {
  if (rule.origin) byOrigin.set(reimportKey(rule.origin, rule.selector), rule)
}

/**
 * Convert the class *names* an HTML importer stamped onto a fragment node
 * (`walkAndMap` copies `el.classList` verbatim) into real registry class *ids*.
 * A name that already names a class links to that class; an unknown name
 * auto-creates a bare (style-less) class so the token still renders and is
 * editable in the class panel.
 *
 * Mutates `rules` (adds new entries) and `byName` (caches them) so repeated
 * names across sibling nodes resolve to one shared class. Must run inside the
 * Mutative recipe that owns the `site` draft.
 */
export function linkImportedClassNames(
  classNames: readonly string[] | undefined,
  rules: Record<string, StyleRule>,
  byName: Map<string, string>,
  allocateOrder: StyleRuleOrderAllocator,
): string[] {
  if (!classNames?.length) return []
  const ids: string[] = []
  for (const name of classNames) {
    if (name.length === 0) continue
    let id = byName.get(name)
    if (!id) {
      const now = Date.now()
      // Auto-created classes are always kind:'class' — they exist to back the
      // class-attribute tokens stamped onto imported nodes. The shared
      // transaction allocator keeps appends ordered without rescanning the
      // growing registry for every unknown token.
      const cls: StyleRule = {
        id: nanoid(),
        name,
        kind: 'class',
        selector: classKindSelector(name),
        order: allocateOrder(),
        styles: {},
        contextStyles: {},
        createdAt: now,
        updatedAt: now,
      }
      rules[cls.id] = cls
      byName.set(name, cls.id)
      id = cls.id
    }
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Merge `NewStyleRule[]` parsed from imported `<style>` blocks into the live
 * registry, minting real `StyleRule`s (id + cascade order + timestamps). Used
 * by `insertImportedNodes` so a pasted / agent-authored `<style>` block lands
 * in the Selectors panel and binds to the matching `class=` tokens.
 *
 * Collision policy (first-wins, mirroring the rest of the import pipeline):
 *   - a rule that is a re-import of one already in the registry (same
 *     `origin` + selector, see `findReimportedStyleRule`) replaces that rule
 *     in place, keeping its id and cascade order.
 *   - class rules — otherwise skipped when a class of that name already
 *     exists; the node's `class=` token then links to the existing class.
 *     New names are added and registered in `byName` so
 *     `linkImportedClassNames` (run AFTER this) resolves the token to the
 *     freshly-added rule.
 *   - ambient rules (`body`, `a:hover`, `.a .b`, …) without an origin (pasted
 *     `<style>` CSS has none) — skipped when an ambient rule with the
 *     identical selector already exists, so repeated pastes don't pile up.
 *
 * Mutates `siteRules` and `byName`. Must run inside the Mutative recipe that
 * owns the `site` draft, BEFORE `linkImportedClassNames`.
 */
export function mergeImportedStyleRules(
  rules: readonly NewStyleRule[],
  siteRules: Record<string, StyleRule>,
  byName: Map<string, string>,
  allocateOrder: StyleRuleOrderAllocator,
): void {
  if (rules.length === 0) return

  const byOrigin = indexStyleRulesByOrigin(siteRules)
  const ambientSelectors = new Set<string>()
  for (const r of Object.values(siteRules)) {
    if (r.kind === 'ambient') ambientSelectors.add(r.selector)
  }

  const now = Date.now()
  for (const rule of rules) {
    const reimported = findReimportedStyleRule(byOrigin, rule)
    if (reimported) {
      siteRules[reimported.id] = {
        ...rule,
        id: reimported.id,
        order: reimported.order,
        createdAt: reimported.createdAt,
        updatedAt: now,
      }
      continue
    }
    if (rule.kind === 'class') {
      if (byName.has(rule.name)) continue // existing class wins
    } else if (!rule.origin && ambientSelectors.has(rule.selector)) {
      continue // identical ambient selector already present
    }

    const id = nanoid()
    const newRule: StyleRule = {
      ...rule,
      id,
      order: allocateOrder(),
      createdAt: now,
      updatedAt: now,
    }
    siteRules[id] = newRule
    registerStyleRuleOrigin(byOrigin, newRule)
    if (rule.kind === 'class') byName.set(rule.name, id)
    else ambientSelectors.add(rule.selector)
  }
}
