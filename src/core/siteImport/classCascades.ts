/**
 * classCascades — cross-sheet class semantics for CONVERTED stylesheets.
 *
 * ## The problem
 *
 * A multi-page site export routinely reuses the SAME class name with
 * DIFFERENT declarations across per-page stylesheets — e.g. `index.html`'s
 * stylesheet defines `.btn { border-radius: 0 }` while `original.html`'s
 * defines `.btn { border-radius: 999px }`. The CMS has ONE global class
 * registry, so naively merging makes one page's `.btn` clobber the other's.
 *
 * ## The model — explicit conflicts, CSS-native otherwise
 *
 * Converted stylesheets merge into the site's one global cascade exactly like
 * a browser loading them all: identical definitions share a class, repeated
 * definitions within one page cascade keep their source-order effect (see
 * `normalizeBindableClassRules`). When two page cascades produce genuinely
 * DIVERGENT effective definitions for one class, that is surfaced as a
 * `CrossSheetClassConflict` in the wizard's Conflicts step — the user picks
 * rename / keep-first / overwrite per class, instead of the importer silently
 * generating scope classes. (The previous automatic
 * `instatic-import-scope-*` body-class machinery is gone; pages that need
 * hard isolation keep their stylesheet as a file instead — see
 * `StylesheetImportMode`.)
 *
 * Bootstrap-like scaffold / utility names (`row`, `col-xl-3`, `d-flex`, …)
 * never conflict: their behaviour is intentionally assembled from many small
 * rules across stylesheets, so splitting them by content would break the grid
 * contract. They stay global.
 */

import type {
  CrossSheetClassConflict,
  ImportPlan,
  NewStyleRule,
  PagePlan,
} from './types'
import type { CssFileResult } from './assetPlan'
import {
  classKindSelector,
  replaceCssSelectorClassName,
  selectorBindingClassName,
} from '@core/page-tree'
import { canonicalJson } from '@core/utils/canonicalJson'
import {
  createCascadedStyleRuleLayers,
  mergeStyleRuleCascade,
  type CascadedStyleRuleLayers,
} from './declarationCascade'

// ---------------------------------------------------------------------------
// Shared utility class names
// ---------------------------------------------------------------------------

const BOOTSTRAP_BREAKPOINT_RE = '(?:sm|md|lg|xl|xxl)'
const BOOTSTRAP_SIZE_RE = '(?:0|1|2|3|4|5|auto)'
const BOOTSTRAP_GRID_SPAN_RE = '(?:auto|[1-9]|1[0-2])'
const BOOTSTRAP_SIDE_RE = '(?:t|b|s|e|x|y)'

const SHARED_UTILITY_CLASS_PATTERNS = [
  /^container(?:-(?:sm|md|lg|xl|xxl|fluid))?$/,
  /^row(?:-cols(?:-(?:sm|md|lg|xl|xxl))?-(?:auto|[1-6]))?$/,
  new RegExp(`^col(?:-${BOOTSTRAP_GRID_SPAN_RE}|-${BOOTSTRAP_BREAKPOINT_RE}(?:-${BOOTSTRAP_GRID_SPAN_RE})?)?$`),
  new RegExp(`^offset(?:-${BOOTSTRAP_BREAKPOINT_RE})?-(?:[0-9]|1[0-1])$`),
  new RegExp(`^order(?:-${BOOTSTRAP_BREAKPOINT_RE})?-(?:first|last|[0-5])$`),
  new RegExp(`^(?:g|gx|gy)(?:-${BOOTSTRAP_BREAKPOINT_RE})?-${BOOTSTRAP_SIZE_RE}$`),
  new RegExp(`^(?:m|p)${BOOTSTRAP_SIDE_RE}?(?:-${BOOTSTRAP_BREAKPOINT_RE})?-${BOOTSTRAP_SIZE_RE}$`),
  new RegExp('^d(?:-(?:sm|md|lg|xl|xxl))?-(?:none|inline|inline-block|block|grid|table|table-row|table-cell|flex|inline-flex)$'),
  new RegExp('^flex(?:-(?:sm|md|lg|xl|xxl))?-(?:row|column|row-reverse|column-reverse|wrap|nowrap|wrap-reverse|fill|grow-0|grow-1|shrink-0|shrink-1)$'),
  new RegExp('^justify-content(?:-(?:sm|md|lg|xl|xxl))?-(?:start|end|center|between|around|evenly)$'),
  new RegExp('^align-(?:items|content|self)(?:-(?:sm|md|lg|xl|xxl))?-(?:start|end|center|baseline|stretch)$'),
  /^position-(?:static|relative|absolute|fixed|sticky)$/,
  /^(?:top|bottom|start|end)-(?:0|50|100)$/,
  /^translate-middle(?:-[xy])?$/,
  /^[wh]-(?:25|50|75|100|auto)$/,
  /^mw-100$/,
  /^mh-100$/,
  /^min-vw-100$/,
  /^min-vh-100$/,
  /^vw-100$/,
  /^vh-100$/,
]

/**
 * Class names from Bootstrap's shared layout / utility vocabulary must remain
 * global. They are not component classes: their intended behaviour often spans
 * multiple rules and selectors, so per-definition splitting can break a single
 * grid contract into unrelated names.
 */
export function isSharedUtilityClassName(name: string): boolean {
  return SHARED_UTILITY_CLASS_PATTERNS.some((pattern) => pattern.test(name))
}

// ---------------------------------------------------------------------------
// Cascade model
// ---------------------------------------------------------------------------

interface Cascade {
  /** Ordered CSS file paths (post-@import expansion + synthetic inline). */
  linkedCssPaths: string[]
  /** HTML sources of the pages sharing this exact cascade. */
  pageSources: string[]
}

/** Group pages by their exact ordered stylesheet cascade. */
function buildCascades(pagePlans: readonly PagePlan[]): Cascade[] {
  const byKey = new Map<string, Cascade>()
  for (const plan of pagePlans) {
    if (plan.linkedCssPaths.length === 0) continue
    const key = plan.linkedCssPaths.join('\0')
    const existing = byKey.get(key)
    if (existing) {
      existing.pageSources.push(plan.source)
      continue
    }
    byKey.set(key, { linkedCssPaths: [...plan.linkedCssPaths], pageSources: [plan.source] })
  }
  return [...byKey.values()]
}

/**
 * The effective declaration bags one page cascade produces for each class
 * name: every bindable selector fragment merged in cascade source order, exactly as
 * a browser would cascade equal-specificity rules.
 */
function effectiveClassDefs(
  cascade: Cascade,
  rulesByCssPath: Map<string, NewStyleRule[]>,
): Map<string, CascadedStyleRuleLayers> {
  const defs = new Map<string, CascadedStyleRuleLayers>()
  for (const cssPath of cascade.linkedCssPaths) {
    for (const rule of rulesByCssPath.get(cssPath) ?? []) {
      const name = selectorBindingClassName(rule.selector)
      if (!name || isSharedUtilityClassName(name)) continue
      const def = defs.get(name) ?? createCascadedStyleRuleLayers()
      mergeStyleRuleCascade(def, rule)
      defs.set(name, def)
    }
  }
  return defs
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect class names whose effective definitions DIVERGE across page
 * cascades. The first-encountered definition keeps the bare name; each later
 * distinct definition becomes one conflict whose default resolution renames
 * it to the next free suffix (`btn-2`, `btn-3`, …) — free among both the
 * imported names and the existing site's class names.
 */
export function detectCrossSheetClassConflicts(
  pagePlans: readonly PagePlan[],
  cssFileResults: readonly CssFileResult[],
  existingClassNames: Iterable<string>,
): CrossSheetClassConflict[] {
  const cascades = buildCascades(pagePlans)
  if (cascades.length < 2) return []

  const rulesByCssPath = new Map<string, NewStyleRule[]>()
  const usedNames = new Set<string>(existingClassNames)
  for (const file of cssFileResults) {
    if (!rulesByCssPath.has(file.cssPath)) rulesByCssPath.set(file.cssPath, file.rules)
    for (const rule of file.rules) {
      if (rule.kind === 'class') usedNames.add(rule.name)
    }
  }

  // name → ordered distinct definitions, each with the cascades producing it.
  const defsByName = new Map<string, Array<{ contentKey: string; cascades: Cascade[] }>>()
  for (const cascade of cascades) {
    for (const [name, def] of effectiveClassDefs(cascade, rulesByCssPath)) {
      const contentKey = canonicalJson(def)
      let defs = defsByName.get(name)
      if (!defs) {
        defs = []
        defsByName.set(name, defs)
      }
      const existing = defs.find((d) => d.contentKey === contentKey)
      if (existing) existing.cascades.push(cascade)
      else defs.push({ contentKey, cascades: [cascade] })
    }
  }

  const conflicts: CrossSheetClassConflict[] = []
  for (const [name, defs] of defsByName) {
    if (defs.length < 2) continue
    const keptCssPaths = new Set(defs[0].cascades.flatMap((c) => c.linkedCssPaths))
    for (const def of defs.slice(1)) {
      const sources = [...new Set(
        def.cascades
          .flatMap((c) => c.linkedCssPaths)
          .filter((cssPath) =>
            !keptCssPaths.has(cssPath)
            && (rulesByCssPath.get(cssPath) ?? []).some((r) => selectorBindingClassName(r.selector) === name),
          ),
      )]
      conflicts.push({
        desiredName: name,
        definitionId: hashText(def.contentKey),
        sources,
        pageSources: [...new Set(def.cascades.flatMap((c) => c.pageSources))],
        defaultResolution: { action: 'auto-rename', resolvedName: nextFreeName(name, usedNames) },
      })
    }
  }
  return conflicts
}

// ---------------------------------------------------------------------------
// Resolution application
// ---------------------------------------------------------------------------

/**
 * Apply cross-sheet class resolutions to a plan. Affected cascades are
 * re-identified through each conflict's `pageSources` (stable across plan
 * filtering), never by re-hashing definitions.
 *
 * A rename preserves each fragment's source position. Exclusive fragments
 * move to the new name; shared fragments keep their original selector and
 * gain a renamed companion at the same position. Node class tokens follow.
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

    const renamed = renameCascadeClassFragments(
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
 * Rename selector tokens without collapsing declarations or moving them
 * ahead of intervening selectors. Shared source fragments are cloned so the
 * kept class still receives them at their original cascade position.
 */
function renameCascadeClassFragments(
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

  const styleRules: NewStyleRule[] = []
  const styleRuleSources: string[] = []
  const affectedPaths = new Set(affectedCascadePaths)
  const renames = new Map([[conflict.desiredName, newName]])
  for (let index = 0; index < state.styleRules.length; index += 1) {
    const rule = state.styleRules[index]
    const source = state.styleRuleSources[index]
    const selector = typeof rule.rawCss === 'string' || !affectedPaths.has(source)
      ? rule.selector
      : rewriteSelectorClassTokens(rule.selector, renames)
    if (selector === rule.selector) {
      styleRules.push(rule)
      styleRuleSources.push(source)
      continue
    }

    const ownsRenamedClass = selectorBindingClassName(rule.selector) === conflict.desiredName
    const shared = !exclusivePaths.has(source)
    if (shared) {
      styleRules.push(rule)
      styleRuleSources.push(source)
    }
    styleRules.push({
      ...rule,
      selector,
      kind: ownsRenamedClass ? 'class' : shared ? 'ambient' : rule.kind,
      name: ownsRenamedClass ? newName : shared || rule.kind === 'ambient' ? selector : rule.name,
    })
    styleRuleSources.push(source)
  }

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
    if (selectorBindingClassName(rule.selector) === name && sourceMatches(styleRuleSources[i])) continue
    keptRules.push(rule)
    keptSources.push(styleRuleSources[i])
  }
  return { styleRules: keptRules, styleRuleSources: keptSources }
}

function renamePageClassTokens(page: PagePlan, from: string, to: string): PagePlan {
  const rename = (classIds: readonly string[] | undefined): string[] | null => {
    if (!classIds?.length || !classIds.includes(from)) return null
    const out: string[] = []
    for (const token of classIds) {
      const next = token === from ? to : token
      if (!out.includes(next)) out.push(next)
    }
    return out
  }

  let changed = false
  const nodes: PagePlan['nodeFragment']['nodes'] = {}
  for (const [id, node] of Object.entries(page.nodeFragment.nodes)) {
    const classIds = rename(node.classIds)
    if (classIds) {
      changed = true
      nodes[id] = { ...node, classIds }
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

/** Deterministic JSON with sorted object keys (arrays keep their order). */
function hashText(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

/** First `name-2`, `name-3`, … not already taken; reserves the result. */
function nextFreeName(name: string, used: Set<string>): string {
  let n = 2
  let candidate = `${name}-${n}`
  while (used.has(candidate)) {
    n += 1
    candidate = `${name}-${n}`
  }
  used.add(candidate)
  return candidate
}
