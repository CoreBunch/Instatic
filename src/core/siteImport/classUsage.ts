/**
 * classUsage — which class names each imported page uses: the classes its
 * nodes carry, plus the classes the scripts it loads put on elements at
 * runtime. `classCascades.ts` reads it to tell whether a stylesheet's rules
 * would reach a page that never loaded them.
 */

import type { ImportScript, PagePlan } from './types'

export interface PageClassUsage {
  /** The page carries the class on a node, or a script it loads writes it. */
  uses(pageSource: string, name: string): boolean
  /** A script the page loads writes the class onto elements at runtime. */
  scriptWrites(pageSource: string, name: string): boolean
}

export function pageClassUsage(
  pagePlans: readonly PagePlan[],
  scripts: ReadonlyArray<Pick<ImportScript, 'content' | 'pageSources'>>,
): PageClassUsage {
  const carried = new Map(pagePlans.map((page) => [page.source, carriedClasses(page)] as const))
  const written = new Map<string, Set<string>>()
  for (const script of scripts) {
    const names = scriptClassWrites(script.content)
    for (const source of script.pageSources) {
      const set = written.get(source) ?? new Set<string>()
      for (const name of names) set.add(name)
      written.set(source, set)
    }
  }
  const scriptWrites = (pageSource: string, name: string) => written.get(pageSource)?.has(name) ?? false
  return {
    scriptWrites,
    uses: (pageSource, name) => (carried.get(pageSource)?.has(name) ?? false) || scriptWrites(pageSource, name),
  }
}

function carriedClasses(page: PagePlan): Set<string> {
  const classes = new Set(page.nodeFragment.body?.classIds ?? [])
  for (const node of Object.values(page.nodeFragment.nodes)) {
    for (const name of node.classIds ?? []) classes.add(name)
  }
  return classes
}

/**
 * Class names a script can put on an element at runtime: the arguments of
 * `classList.add/toggle/replace`, string assignments to `className`,
 * `setAttribute('class', …)`, and `class="…"` inside HTML it builds from
 * strings or templates. Selector strings (`querySelector('.btn')`) style
 * nothing and do not count.
 */
const CLASS_WRITE_PATTERNS = [
  /classList\s*\.\s*(?:add|toggle|replace)\s*\(([^)]*)\)/g,
  /className\s*\+?=\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g,
  /setAttribute\s*\(\s*['"]class['"]\s*,([^)]*)\)/g,
  /\bclass\s*=\s*\\?(['"])((?:(?!\1).)*?)\\?\1/g,
]

function scriptClassWrites(source: string): Set<string> {
  const names = new Set<string>()
  for (const pattern of CLASS_WRITE_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const text = match[match.length - 1] ?? ''
      for (const literal of pattern === CLASS_WRITE_PATTERNS[0] || pattern === CLASS_WRITE_PATTERNS[2]
        ? text.match(/'[^']*'|"[^"]*"|`[^`]*`/g) ?? []
        : [` ${text} `]) {
        for (const run of literal.slice(1, -1).split(/[^A-Za-z0-9_-]+/)) {
          if (run) names.add(run)
        }
      }
    }
  }
  return names
}
