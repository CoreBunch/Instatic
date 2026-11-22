/**
 * classCascadeResolution — apply the user's choices for cross-sheet class
 * conflicts (`classCascades.ts` detects them) to an import plan, and enforce
 * the registry's one-bindable-class-per-name invariant afterwards.
 *
 * - `leak` rows confine a stylesheet's rules for a class to the pages that
 *   load it (rename), keep them global (overwrite), or drop them (skip).
 * - `divergent` rows materialise, keep-first or overwrite a definition.
 */

import type {
  ImportPlan,
  NewStyleRule,
  PagePlan,
} from './types'
import type { CrossSheetClassConflict } from './conflictTypes'
import {
  classKindSelector,
  extractCssSelectorClasses,
  replaceCssSelectorClassName,
} from '@core/page-tree'
import {
  createCascadedStyleRuleLayers,
  mergeStyleRuleCascade,
  sparseContextPriorities,
  sparsePriorities,
  type CascadedStyleRuleLayers,
} from './declarationCascade'

// ---------------------------------------------------------------------------
// Resolution application
// ---------------------------------------------------------------------------

/**
 * Apply cross-sheet class resolutions to a plan. Affected cascades are
 * re-identified through each conflict's `pageSources` (stable across plan
 * filtering), never by re-hashing definitions.
 *
 * For a rename, the divergent definition is MATERIALISED: one class rule
 * named `resolvedName` carrying the cascade-merged effective declarations is
 * appended, the affected cascades' exclusive class fragments for the old name
 * are dropped, class tokens in their exclusive ambient selectors follow the
 * rename, and the affected pages' node class tokens move to the new name.
 * Fragments living in stylesheets SHARED with a kept cascade stay put (they
 * also feed the kept definition); their declarations are still present in the
 * materialised rule.
 */
export function applyCrossSheetClassResolutions(
  plan: ImportPlan,
  resolutions: readonly CrossSheetClassConflict[],
): ImportPlan {
  if (resolutions.length === 0) return plan

  let pages = plan.pages
  let styleRules = [...plan.styleRules]
  let styleRuleSources = [...plan.styleRuleSources]

  for (const conflict of resolutions) {
    const res = conflict.defaultResolution
    if (conflict.kind === 'leak') {
      const confined = applyLeakResolution({ pages, styleRules, styleRuleSources }, conflict)
      pages = confined.pages
      styleRules = confined.styleRules
      styleRuleSources = confined.styleRuleSources
      continue
    }
    const affectedPages = new Set(conflict.pageSources)
    const affectedCascadePaths = orderedCascadePaths(pages, affectedPages)
    const otherCascadePaths = new Set(
      pages
        .filter((p) => !affectedPages.has(p.source))
        .flatMap((p) => p.linkedCssPaths),
    )
    const exclusivePaths = new Set(affectedCascadePaths.filter((p) => !otherCascadePaths.has(p)))

    if (res.action === 'overwrite') {
      // This definition wins the bare name: drop every OTHER cascade's
      // exclusive class fragments for it, so all pages bind to this one.
      const affectedPathSet = new Set(affectedCascadePaths)
      const removed = removeClassFragments(
        styleRules,
        styleRuleSources,
        conflict.desiredName,
        (source) => !affectedPathSet.has(source),
      )
      styleRules = removed.styleRules
      styleRuleSources = removed.styleRuleSources
      continue
    }

    if (res.action === 'skip') {
      // Keep the first definition: drop this definition's exclusive fragments;
      // its pages bind to the kept definition by name.
      const removed = removeClassFragments(
        styleRules,
        styleRuleSources,
        conflict.desiredName,
        (source) => exclusivePaths.has(source),
      )
      styleRules = removed.styleRules
      styleRuleSources = removed.styleRuleSources
      continue
    }

    const newName = res.resolvedName
    if (!newName || newName === conflict.desiredName) continue

    const renamed = materialiseRenamedClass(
      { pages, styleRules, styleRuleSources },
      conflict,
      newName,
      { affectedPages, affectedCascadePaths, exclusivePaths },
    )
    pages = renamed.pages
    styleRules = renamed.styleRules
    styleRuleSources = renamed.styleRuleSources
  }

  return { ...plan, pages, styleRules, styleRuleSources }
}

interface CascadeRuleState {
  pages: PagePlan[]
  styleRules: NewStyleRule[]
  styleRuleSources: string[]
}

/**
 * Resolve one `leak` row. `overwrite` leaves the sheet's fragments on the
 * bare name (they reach every page); `skip` drops them; a rename moves the
 * sheet's class fragments and the class tokens in its other selectors to the
 * new name, and adds that name next to the bare one on the elements of the
 * pages that load the sheet. The renamed rules keep their position in plan
 * order, so each page cascades exactly as its source did.
 */
function applyLeakResolution(
  state: CascadeRuleState,
  conflict: CrossSheetClassConflict,
): CascadeRuleState {
  const res = conflict.defaultResolution
  const sheet = conflict.sources[0]
  if (res.action === 'overwrite') return state
  if (res.action === 'skip') {
    // Every rule of the sheet whose selector names the class goes, not just
    // the class rules: `.btn:hover` or `.card .btn` would still reach pages
    // that never loaded the sheet.
    const styleRules: NewStyleRule[] = []
    const styleRuleSources: string[] = []
    state.styleRules.forEach((rule, index) => {
      const source = state.styleRuleSources[index]
      const names = source === sheet && typeof rule.rawCss !== 'string'
        ? extractCssSelectorClasses(rule.selector).map((token) => token.name)
        : []
      if (names.includes(conflict.desiredName)) return
      styleRules.push(rule)
      styleRuleSources.push(source)
    })
    return { pages: state.pages, styleRules, styleRuleSources }
  }
  const newName = res.resolvedName
  if (!newName || newName === conflict.desiredName) return state

  const renames = new Map([[conflict.desiredName, newName]])
  const styleRules = state.styleRules.map((rule, index) => {
    if (state.styleRuleSources[index] !== sheet) return rule
    if (typeof rule.rawCss === 'string') return rule
    // Every selector of the sheet that names the class follows, whatever the
    // rule's own class: `.side .icon` (class `icon`), `.x:not(.btn)` (class
    // `x`), `.btn .row` (class `row`). Only the class token is rewritten.
    const selector = rewriteSelectorClassTokens(rule.selector, renames)
    if (selector === rule.selector) return rule
    if (rule.kind === 'class') {
      return { ...rule, selector, ...(rule.name === conflict.desiredName ? { name: newName } : {}) }
    }
    return { ...rule, selector, name: rule.name === rule.selector ? selector : rule.name }
  })
  const affectedPages = new Set(conflict.pageSources)
  const pages = state.pages.map((page) =>
    affectedPages.has(page.source) ? addPageClassToken(page, conflict.desiredName, newName) : page,
  )
  return { pages, styleRules, styleRuleSources: state.styleRuleSources }
}

/**
 * Apply one rename resolution: materialise the divergent definition under
 * `newName` and move every reference in the affected cascades with it.
 *
 *   1. Materialise the effective definition under the new name, merged in
 *      this cascade's source order (shared fragments included).
 *   2. Drop the exclusive source fragments the materialised rule replaces.
 *   3. Class tokens in the cascade's exclusive ambient selectors follow.
 *   4. The affected pages' node class tokens move to the new name.
 */
function materialiseRenamedClass(
  state: CascadeRuleState,
  conflict: CrossSheetClassConflict,
  newName: string,
  scope: {
    affectedPages: ReadonlySet<string>
    affectedCascadePaths: readonly string[]
    exclusivePaths: ReadonlySet<string>
  },
): CascadeRuleState {
  const { affectedPages, affectedCascadePaths, exclusivePaths } = scope

  const merged = mergeClassDefinition(
    state.styleRules,
    state.styleRuleSources,
    affectedCascadePaths,
    conflict.desiredName,
  )
  const removed = removeClassFragments(
    state.styleRules,
    state.styleRuleSources,
    conflict.desiredName,
    (source) => exclusivePaths.has(source),
  )
  let styleRules = removed.styleRules
  const styleRuleSources = removed.styleRuleSources
  if (merged) {
    styleRules.push({
      kind: 'class',
      name: newName,
      selector: classKindSelector(newName),
      order: 0,
      styles: merged.styles as NewStyleRule['styles'],
      ...(sparsePriorities(merged.stylePriorities)
        ? { stylePriorities: merged.stylePriorities }
        : {}),
      contextStyles: merged.contextStyles as NewStyleRule['contextStyles'],
      ...(sparseContextPriorities(merged.contextStylePriorities)
        ? { contextStylePriorities: sparseContextPriorities(merged.contextStylePriorities) }
        : {}),
    })
    styleRuleSources.push(conflict.sources[0] ?? affectedCascadePaths[0] ?? '')
  }

  const renames = new Map([[conflict.desiredName, newName]])
  styleRules = styleRules.map((rule, index) => {
    if (rule.kind !== 'ambient' || typeof rule.rawCss === 'string') return rule
    if (!exclusivePaths.has(styleRuleSources[index])) return rule
    const selector = rewriteSelectorClassTokens(rule.selector, renames)
    if (selector === rule.selector) return rule
    return { ...rule, selector, name: rule.name === rule.selector ? selector : rule.name }
  })

  const pages = state.pages.map((page) => {
    if (!affectedPages.has(page.source)) return page
    return renamePageClassTokens(page, conflict.desiredName, newName)
  })

  return { pages, styleRules, styleRuleSources }
}

/**
 * Enforce the global registry's unique-class-name invariant over a plan's
 * rules: per class name, the FIRST class-kind rule (in plan order — cascade
 * source order) stays bindable; every later same-name class rule becomes an
 * ambient rule with the same selector, preserving its cascade position and
 * declarations. Run AFTER all renames so it sees final names.
 */
export function normalizeBindableClassRules(plan: ImportPlan): ImportPlan {
  const seen = new Set<string>()
  let changed = false
  const styleRules = plan.styleRules.map((rule) => {
    if (rule.kind !== 'class') return rule
    if (!seen.has(rule.name)) {
      seen.add(rule.name)
      return rule
    }
    changed = true
    return { ...rule, kind: 'ambient' as const, name: rule.selector }
  })
  return changed ? { ...plan, styleRules } : plan
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Ordered union of the affected pages' cascades (first page's order wins). */
function orderedCascadePaths(pages: readonly PagePlan[], affectedPages: ReadonlySet<string>): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const page of pages) {
    if (!affectedPages.has(page.source)) continue
    for (const cssPath of page.linkedCssPaths) {
      if (seen.has(cssPath)) continue
      seen.add(cssPath)
      ordered.push(cssPath)
    }
  }
  return ordered
}

function removeClassFragments(
  styleRules: NewStyleRule[],
  styleRuleSources: string[],
  name: string,
  sourceMatches: (source: string) => boolean,
): { styleRules: NewStyleRule[]; styleRuleSources: string[] } {
  const keptRules: NewStyleRule[] = []
  const keptSources: string[] = []
  for (let i = 0; i < styleRules.length; i++) {
    const rule = styleRules[i]
    if (rule.kind === 'class' && rule.name === name && sourceMatches(styleRuleSources[i])) continue
    keptRules.push(rule)
    keptSources.push(styleRuleSources[i])
  }
  return { styleRules: keptRules, styleRuleSources: keptSources }
}

function mergeClassDefinition(
  styleRules: readonly NewStyleRule[],
  styleRuleSources: readonly string[],
  cascadePaths: readonly string[],
  name: string,
): CascadedStyleRuleLayers | null {
  const indexBySource = new Map<string, number[]>()
  for (let i = 0; i < styleRules.length; i++) {
    const rule = styleRules[i]
    if (rule.kind !== 'class' || rule.name !== name) continue
    const list = indexBySource.get(styleRuleSources[i]) ?? []
    list.push(i)
    indexBySource.set(styleRuleSources[i], list)
  }

  let found = false
  const merged = createCascadedStyleRuleLayers()
  for (const cssPath of cascadePaths) {
    for (const index of indexBySource.get(cssPath) ?? []) {
      const rule = styleRules[index]
      found = true
      mergeStyleRuleCascade(merged, rule)
    }
  }
  return found ? merged : null
}

/** Replace `from` with `to` on every element of the page that carries it. */
function renamePageClassTokens(page: PagePlan, from: string, to: string): PagePlan {
  return mapPageClassTokens(page, from, (token) => [token === from ? to : token])
}

/** Add `to` right after `from` on every element of the page that carries `from`. */
function addPageClassToken(page: PagePlan, from: string, to: string): PagePlan {
  return mapPageClassTokens(page, from, (token) => (token === from ? [from, to] : [token]))
}

/** Map class tokens inside every `class="…"` attribute of a markup string; null when unchanged. */
function mapMarkupClassTokens(
  markup: string,
  from: string,
  mapToken: (token: string) => string[],
): string | null {
  let changed = false
  const next = markup.replace(/(\sclass\s*=\s*)(["'])([^"']*)\2/gi, (whole, prefix: string, quote: string, value: string) => {
    const tokens = value.split(/\s+/).filter(Boolean)
    if (!tokens.includes(from)) return whole
    changed = true
    const out: string[] = []
    for (const token of tokens) {
      for (const mapped of mapToken(token)) if (!out.includes(mapped)) out.push(mapped)
    }
    return `${prefix}${quote}${out.join(' ')}${quote}`
  })
  return changed ? next : null
}

function mapPageClassTokens(
  page: PagePlan,
  from: string,
  mapToken: (token: string) => string[],
): PagePlan {
  const rename = (classIds: readonly string[] | undefined): string[] | null => {
    if (!classIds?.length || !classIds.includes(from)) return null
    const out: string[] = []
    for (const token of classIds) {
      for (const next of mapToken(token)) {
        if (!out.includes(next)) out.push(next)
      }
    }
    return out
  }

  let changed = false
  const nodes: PagePlan['nodeFragment']['nodes'] = {}
  for (const [id, node] of Object.entries(page.nodeFragment.nodes)) {
    const classIds = rename(node.classIds)
    // Inline SVG is stored as one markup string (`base.svg` `props.svg`), so
    // its inner elements' classes follow in the markup itself.
    const svg = typeof node.props.svg === 'string' ? mapMarkupClassTokens(node.props.svg, from, mapToken) : null
    if (classIds || svg !== null) {
      changed = true
      nodes[id] = {
        ...node,
        ...(classIds ? { classIds } : {}),
        ...(svg !== null ? { props: { ...node.props, svg } } : {}),
      }
    } else {
      nodes[id] = node
    }
  }
  let body = page.nodeFragment.body
  const bodyClassIds = rename(body?.classIds)
  if (body && bodyClassIds) {
    changed = true
    body = { ...body, classIds: bodyClassIds }
  }
  if (!changed) return page
  return { ...page, nodeFragment: { ...page.nodeFragment, nodes, ...(body ? { body } : {}) } }
}

function rewriteSelectorClassTokens(selector: string, renames: Map<string, string>): string {
  let rewritten = selector
  for (const [fromName, toName] of renames) {
    if (fromName === toName) continue
    rewritten = replaceCssSelectorClassName(
      rewritten,
      fromName,
      classKindSelector(toName).slice(1),
    )
  }
  return rewritten
}
