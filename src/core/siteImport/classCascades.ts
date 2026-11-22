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
 * The common shape is a shared kit restyled by a page's own sheet, or a class
 * only one page's sheet styles that another page also uses. Either way the
 * one global registry would carry that sheet's rules onto pages that never
 * loaded it, so it is a `leak` conflict whenever another imported page uses
 * the class without loading the sheet. Its default resolution is lossless:
 * the sheet's fragments move to a new name that its pages carry NEXT TO the
 * bare class, so a kit's own selectors (`.btn .icon`) keep matching and the
 * rules apply in the same order as in the source. A sheet every user of the
 * class loads raises nothing, since keeping it global changes no page.
 *
 * Bootstrap-like scaffold / utility names (`row`, `col-xl-3`, `d-flex`, …)
 * never conflict: their behaviour is intentionally assembled from many small
 * rules across stylesheets, so splitting them by content would break the grid
 * contract. They stay global.
 */

import type {
  ImportScript,
  NewStyleRule,
  PagePlan,
} from './types'
import type { CrossSheetClassConflict } from './conflictTypes'
import type { CssFileResult } from './assetPlan'
import type { StyleRule } from '@core/page-tree'
import { canonicalJson } from '@core/utils/canonicalJson'
import { importClassNames, pageClassUsage } from './classUsage'
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
 * name: every class-kind fragment merged in cascade source order, exactly as
 * a browser would cascade equal-specificity rules.
 */
function effectiveClassDefs(
  cascade: Cascade,
  rulesByCssPath: Map<string, NewStyleRule[]>,
): Map<string, CascadedStyleRuleLayers> {
  const defs = new Map<string, CascadedStyleRuleLayers>()
  for (const cssPath of cascade.linkedCssPaths) {
    for (const rule of rulesByCssPath.get(cssPath) ?? []) {
      if (rule.kind !== 'class' || isSharedUtilityClassName(rule.name)) continue
      const def = defs.get(rule.name) ?? createCascadedStyleRuleLayers()
      mergeStyleRuleCascade(def, rule)
      defs.set(rule.name, def)
    }
  }
  return defs
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect class definitions the one global registry would carry onto imported
 * pages that never loaded them.
 *
 * - When every cascade loads the sheets defining a class in plan order (see
 *   `definingSheetsInPlanOrder`), each such sheet is one `leak` row if some
 *   imported page uses the class without loading that sheet. A sheet every
 *   user of the class loads raises nothing: keeping it global changes no page.
 * - Otherwise the first-encountered definition keeps the bare name and each
 *   later distinct definition is one `divergent` row.
 *
 * Every row defaults to renaming to the next free suffix (`btn-2`, …), free
 * among both the imported names and the existing site's class names. A leak
 * row whose sheet an earlier import already confined reuses that import's
 * name (an existing class rule with the same `origin.source` named
 * `<name>-<n>`), so re-importing reconciles in place instead of stacking a
 * new copy. `scripts` are the imported scripts: a class a script names counts
 * as used on every page that loads the script (see `classUsage.ts`).
 */
export function detectCrossSheetClassConflicts(
  pagePlans: readonly PagePlan[],
  cssFileResults: readonly CssFileResult[],
  existingClassRules: ReadonlyArray<Pick<StyleRule, 'name' | 'origin'>>,
  scripts: ReadonlyArray<Pick<ImportScript, 'content' | 'pageSources'>> = [],
): CrossSheetClassConflict[] {
  const cascades = buildCascades(pagePlans)
  if (cascades.length === 0) return []

  const rulesByCssPath = new Map<string, NewStyleRule[]>()
  const usage = pageClassUsage(pagePlans, scripts)
  const authoredNames = importClassNames(usage, cssFileResults.flatMap((file) => file.rules))
  const usedNames = new Set([...authoredNames, ...existingClassRules.map((rule) => rule.name)])
  // class name → the sheets defining it, built once (detection is per class
  // per cascade per sheet, so a per-lookup scan of each sheet's rules is
  // quadratic on large imports).
  const sheetsDefining = new Map<string, Set<string>>()
  for (const file of cssFileResults) {
    if (!rulesByCssPath.has(file.cssPath)) rulesByCssPath.set(file.cssPath, file.rules)
    for (const rule of file.rules) {
      if (rule.kind !== 'class') continue
      const sheets = sheetsDefining.get(rule.name) ?? new Set<string>()
      sheets.add(file.cssPath)
      sheetsDefining.set(rule.name, sheets)
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

  const planOrder = new Map(cssFileResults.map((file, index) => [file.cssPath, index] as const))
  const linked = new Map(pagePlans.map((page) => [page.source, new Set(page.linkedCssPaths)] as const))
  const loadsSheet = (pageSource: string, sheet: string) => linked.get(pageSource)?.has(sheet) ?? false
  const pagesLoading = new Map<string, string[]>()
  for (const page of pagePlans) {
    for (const sheet of new Set(page.linkedCssPaths)) {
      const list = pagesLoading.get(sheet) ?? []
      list.push(page.source)
      pagesLoading.set(sheet, list)
    }
  }
  const confinedBefore = previouslyConfinedNames(existingClassRules, authoredNames)
  const nameFor = (name: string, sheet: string): string => {
    const previous = confinedBefore.get(`${sheet}\0${name}`)
    if (previous) return previous
    return nextFreeName(name, usedNames)
  }

  const conflicts: CrossSheetClassConflict[] = []
  for (const [name, defs] of defsByName) {
    const defining = sheetsDefining.get(name) ?? new Set<string>()
    const sheets = definingSheetsInPlanOrder(defs.flatMap((d) => d.cascades), defining, planOrder)
    if (sheets) {
      for (const sheet of sheets) {
        // When every defining cascade produces the same definition, a page
        // that defines the class itself gets that same definition either way;
        // only a page defining it nowhere would change.
        const affected = (pageSource: string) =>
          !loadsSheet(pageSource, sheet)
          && (defs.length > 1 || ![...(linked.get(pageSource) ?? [])].some((cssPath) => defining.has(cssPath)))
        if (!usage.pagesUsing(name).some(affected)) continue
        const ownPages = pagesLoading.get(sheet) ?? []
        // Code on the sheet's own pages (a script, or SVG markup stored as a
        // string) may put the class on elements that will never carry the new
        // name, so a rename could break those pages. Keep the rules global by
        // default there; the row still tells the user they reach other pages.
        const unrenameable = ownPages.some((pageSource) => usage.outsideNodes(pageSource, name))
        conflicts.push({
          kind: 'leak',
          desiredName: name,
          definitionId: hashText(`leak\0${sheet}`),
          sources: [sheet],
          pageSources: [...ownPages],
          defaultResolution: {
            action: unrenameable ? 'overwrite' : 'auto-rename',
            resolvedName: nameFor(name, sheet),
          },
        })
      }
      continue
    }
    if (defs.length < 2) continue

    const keptCssPaths = new Set(defs[0].cascades.flatMap((c) => c.linkedCssPaths))
    for (const def of defs.slice(1)) {
      const sources = [...new Set(
        def.cascades
          .flatMap((c) => c.linkedCssPaths)
          .filter((cssPath) => !keptCssPaths.has(cssPath) && defining.has(cssPath)),
      )]
      conflicts.push({
        kind: 'divergent',
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

/** The class names cross-sheet rows rename to, for other conflict rows to keep clear of. */
export function crossSheetRenameTargets(conflicts: readonly CrossSheetClassConflict[]): string[] {
  return conflicts.flatMap((conflict) => {
    const res = conflict.defaultResolution
    return res.resolvedName ? [res.resolvedName] : []
  })
}

/**
 * `<sheet>\0<name>` → the name an earlier import confined that sheet's class
 * under: an existing class rule from the sheet (`origin.source`) whose name is
 * `<name>-<n>`.
 */
function previouslyConfinedNames(
  rules: ReadonlyArray<Pick<StyleRule, 'name' | 'origin'>>,
  authoredNames: ReadonlySet<string>,
): Map<string, string> {
  const names = new Map<string, string>()
  for (const rule of rules) {
    const source = rule.origin?.source
    const match = /^(.+)-(\d+)$/.exec(rule.name)
    if (!source || !match || authoredNames.has(rule.name)) continue
    const key = `${source}\0${match[1]}`
    if (!names.has(key)) names.set(key, rule.name)
  }
  return names
}

/**
 * The sheets defining a class across the cascades, in plan order, or null
 * when some cascade loads them in a different order than the plan emits them.
 *
 * In order, confining any of them is lossless: a page carries the bare class
 * plus the new name of each confined sheet it loads, and one global
 * stylesheet in plan order then applies exactly that page's own fragments in
 * its own cascade order. Out of order, no single global order can reproduce
 * every page, so the class falls back to `divergent` rows.
 */
function definingSheetsInPlanOrder(
  cascades: readonly Cascade[],
  defining: ReadonlySet<string>,
  planOrder: Map<string, number>,
): string[] | null {
  const all = new Set<string>()
  for (const cascade of cascades) {
    let last = -1
    for (const sheet of cascade.linkedCssPaths) {
      if (!defining.has(sheet)) continue
      const index = planOrder.get(sheet) ?? -1
      if (index < last) return null
      last = index
      all.add(sheet)
    }
  }
  return [...all].sort((a, b) => (planOrder.get(a) ?? 0) - (planOrder.get(b) ?? 0))
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
