/**
 * Shared name→id linking utilities for HTML import operations.
 *
 * Extracted so both `insertImportedNodes` (single-page fragment insert) and
 * `mutateAllPagesAndSite` (whole-site Super Import) share the same canonical
 * algorithm without duplication.
 */

import { nanoid } from 'nanoid'
import { classKindSelector } from '@core/page-tree'
import type { StyleRule } from '@core/page-tree'
import type { NewStyleRule } from '@core/siteImport'

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
): string[] {
  if (!classNames?.length) return []
  const ids: string[] = []
  for (const name of classNames) {
    if (name.length === 0) continue
    let id = byName.get(name)
    if (!id) {
      const now = Date.now()
      // Auto-created classes are always kind:'class' — they exist to back the
      // class-attribute tokens stamped onto imported nodes. Append at the
      // end of the cascade (`order` strictly greater than every existing
      // rule) so they don't accidentally outrank prior user-authored rules.
      let maxOrder = -1
      for (const c of Object.values(rules)) {
        if (typeof c.order === 'number' && c.order > maxOrder) maxOrder = c.order
      }
      const cls: StyleRule = {
        id: nanoid(),
        name,
        kind: 'class',
        selector: classKindSelector(name),
        order: maxOrder + 1,
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
 *   - class rules — skipped when a class of that name already exists; the
 *     node's `class=` token then links to the existing class. New names are
 *     added and registered in `byName` so `linkImportedClassNames` (run AFTER
 *     this) resolves the token to the freshly-added rule.
 *   - ambient rules (`body`, `a:hover`, `.a .b`, …) — skipped when an ambient
 *     rule with the identical selector already exists, so repeated imports
 *     don't pile up duplicates.
 *
 * Mutates `siteRules` and `byName`. Must run inside the Mutative recipe that
 * owns the `site` draft, BEFORE `linkImportedClassNames`.
 */
export function mergeImportedStyleRules(
  rules: readonly NewStyleRule[],
  siteRules: Record<string, StyleRule>,
  byName: Map<string, string>,
): void {
  if (rules.length === 0) return

  let maxOrder = -1
  const ambientSelectors = new Set<string>()
  for (const r of Object.values(siteRules)) {
    if (typeof r.order === 'number' && r.order > maxOrder) maxOrder = r.order
    if (r.kind === 'ambient') ambientSelectors.add(r.selector)
  }

  const now = Date.now()
  for (const rule of rules) {
    if (rule.kind === 'class') {
      if (byName.has(rule.name)) continue // existing class wins
    } else if (ambientSelectors.has(rule.selector)) {
      continue // identical ambient selector already present
    }

    const id = nanoid()
    const newRule: StyleRule = {
      ...rule,
      id,
      order: (maxOrder += 1),
      createdAt: now,
      updatedAt: now,
    }
    siteRules[id] = newRule
    if (rule.kind === 'class') byName.set(rule.name, id)
    else ambientSelectors.add(rule.selector)
  }
}
