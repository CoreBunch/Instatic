import {
  extractCssSelectorClasses,
  isGeneratedClass,
  splitCssSelectorList,
  type SiteDocument,
  type StyleRule,
} from '@core/page-tree'

let lastScriptFiles: SiteDocument['files'] | null = null
let lastScriptRuns: Set<string> = new Set()

/**
 * Identifier-shaped runs in a runtime script's source.
 *
 * A modifier a script toggles never appears on an authored node, so node class
 * ids alone cannot see it. The script is the only place it is written down, in
 * whatever call the author used — `classList.add('nav--open')`, a `className`
 * assignment, a template literal, a lookup table of state names. Rather than
 * model those shapes, split the source on everything a CSS class name cannot
 * contain and keep the runs that survive.
 *
 * This over-collects: `add`, `length` and every other identifier in the file
 * land in the set too, so a class named after one of them is kept even when no
 * script really references it. That is the safe direction. The cost of a false
 * positive is a few bytes of CSS; the cost of a false negative is a rule that
 * is correct everywhere until publish drops it and the feature dies on the
 * live site with nothing to point at.
 */
function scriptIdentifierRuns(files: SiteDocument['files']): Set<string> {
  // `usedStyleRuleIdSignature` runs inside a canvas store selector, so this is
  // hit on every store change. The store snapshot is immutable, so identity on
  // the files array is enough to skip re-splitting unchanged sources.
  if (files === lastScriptFiles) return lastScriptRuns

  const runs = new Set<string>()
  for (const file of files) {
    if (file.type !== 'script' || typeof file.content !== 'string') continue
    for (const run of file.content.split(/[^A-Za-z0-9_-]+/)) {
      if (run) runs.add(run)
    }
  }

  lastScriptFiles = files
  lastScriptRuns = runs
  return runs
}

/**
 * Collect every registry class id referenced by page and Visual Component
 * nodes, plus every class a runtime script names.
 *
 * Script-referenced ids are unioned in, never subtracted, so this can only
 * ever keep more CSS than node class ids alone would.
 */
export function collectUsedStyleRuleIds(
  site: Pick<SiteDocument, 'pages' | 'visualComponents' | 'files' | 'styleRules'>,
): Set<string> {
  const usedIds = new Set<string>()
  for (const page of site.pages) {
    for (const node of Object.values(page.nodes)) {
      for (const id of node.classIds ?? []) usedIds.add(id)
    }
  }
  for (const component of site.visualComponents ?? []) {
    for (const id of component.classIds ?? []) usedIds.add(id)
    for (const node of Object.values(component.tree.nodes)) {
      for (const id of node.classIds ?? []) usedIds.add(id)
    }
  }

  const runs = scriptIdentifierRuns(site.files ?? [])
  if (runs.size > 0) {
    for (const rule of Object.values(site.styleRules ?? {})) {
      if (rule.kind === 'class' && runs.has(rule.name)) usedIds.add(rule.id)
    }
  }

  return usedIds
}

/**
 * A stable primitive signature suitable for store subscriptions. It changes
 * only when the set of assigned class ids changes, not for unrelated edits.
 */
export function usedStyleRuleIdSignature(
  site: Pick<SiteDocument, 'pages' | 'visualComponents' | 'files' | 'styleRules'>,
): string {
  return [...collectUsedStyleRuleIds(site)].sort().join('\0')
}

function selectorPartCanMatch(
  selector: string,
  knownClassNames: ReadonlySet<string>,
  usedClassNames: ReadonlySet<string>,
): boolean {
  for (const token of extractCssSelectorClasses(selector)) {
    if (knownClassNames.has(token.name) && !usedClassNames.has(token.name)) {
      return false
    }
  }
  return true
}

function selectorCanMatch(
  selector: string,
  knownClassNames: ReadonlySet<string>,
  usedClassNames: ReadonlySet<string>,
): boolean {
  return splitCssSelectorList(selector).some((part) =>
    selectorPartCanMatch(part, knownClassNames, usedClassNames),
  )
}

/**
 * Select only registry rules that can affect the current document trees.
 *
 * Class rules require their assignment id and every known class dependency in
 * their selector. Ambient selector fragments require every known dependency
 * in at least one selector-list alternative. Class-free selectors and raw
 * stylesheet blocks stay conservative because their reach cannot be inferred
 * from node class ids alone.
 */
export function treeShakeStyleRules(
  styleRules: Record<string, StyleRule>,
  usedIds: ReadonlySet<string>,
): Record<string, StyleRule> {
  const knownClassNames = new Set<string>()
  const usedClassNames = new Set<string>()

  for (const rule of Object.values(styleRules)) {
    if (rule.kind !== 'class') continue
    knownClassNames.add(rule.name)
    if (usedIds.has(rule.id)) usedClassNames.add(rule.name)
  }

  const selected: Record<string, StyleRule> = {}
  for (const rule of Object.values(styleRules)) {
    if (isGeneratedClass(rule)) continue

    if (rule.kind === 'class') {
      if (
        usedIds.has(rule.id)
        && selectorCanMatch(rule.selector, knownClassNames, usedClassNames)
      ) {
        selected[rule.id] = rule
      }
      continue
    }

    if (
      rule.rawCss
      || selectorCanMatch(rule.selector, knownClassNames, usedClassNames)
    ) {
      selected[rule.id] = rule
    }
  }
  return selected
}

let lastStyleRules: Record<string, StyleRule> | null = null
let lastUsedIdSignature = ''
let lastTreeShakenRules: Record<string, StyleRule> = {}

/**
 * Identity/signature-memoized entry for the multi-frame editor canvas. Every
 * frame sees the same immutable registry snapshot, so a 40k-rule Tailwind
 * registry is filtered once per change rather than once per iframe.
 */
export function treeShakeStyleRulesBySignature(
  styleRules: Record<string, StyleRule>,
  usedIdSignature: string,
): Record<string, StyleRule> {
  if (
    styleRules === lastStyleRules
    && usedIdSignature === lastUsedIdSignature
  ) {
    return lastTreeShakenRules
  }
  const usedIds = usedIdSignature
    ? new Set(usedIdSignature.split('\0'))
    : new Set<string>()
  lastTreeShakenRules = treeShakeStyleRules(styleRules, usedIds)
  lastStyleRules = styleRules
  lastUsedIdSignature = usedIdSignature
  return lastTreeShakenRules
}
