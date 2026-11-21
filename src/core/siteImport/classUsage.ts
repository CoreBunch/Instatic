/**
 * classUsage — which class names each imported page uses: the classes its
 * nodes carry (inline SVG markup included), plus the classes the scripts it
 * loads may put on elements at runtime. `classCascades.ts` reads it to tell
 * whether a stylesheet's rules would reach a page that never loaded them, and
 * whether renaming a class could miss elements that code creates.
 */

import { extractCssSelectorClasses } from '@core/page-tree'
import type { ImportScript, NewStyleRule, PagePlan } from './types'

export interface PageClassUsage {
  /** Authored class tokens on all imported pages, including scripts. */
  names: Iterable<string>
  /**
   * A script the page loads may put the class on elements at runtime, which
   * a rename of the page's nodes would not reach.
   */
  outsideNodes(pageSource: string, name: string): boolean
  /** The sources of every page that uses the class, in page order. */
  pagesUsing(name: string): readonly string[]
}

export function pageClassUsage(
  pagePlans: readonly PagePlan[],
  scripts: ReadonlyArray<Pick<ImportScript, 'content' | 'pageSources'>>,
): PageClassUsage {
  const carried = new Map(pagePlans.map((page) => [page.source, carriedClasses(page)] as const))
  const written = new Map<string, Set<string>>()
  for (const script of scripts) {
    const names = scriptClassNames(script.content)
    for (const source of script.pageSources) {
      const set = written.get(source) ?? new Set<string>()
      for (const name of names) set.add(name)
      written.set(source, set)
    }
  }
  const outsideNodes = (pageSource: string, name: string) => written.get(pageSource)?.has(name) ?? false
  const users = new Map<string, string[]>()
  for (const page of pagePlans) {
    const names = new Set([...(carried.get(page.source) ?? []), ...(written.get(page.source) ?? [])])
    for (const name of names) {
      const list = users.get(name) ?? []
      list.push(page.source)
      users.set(name, list)
    }
  }
  return {
    outsideNodes,
    names: users.keys(),
    pagesUsing: (name) => users.get(name) ?? [],
  }
}

/** Every authored class name a generated rename target must keep clear of. */
export function importClassNames(usage: PageClassUsage, rules: Iterable<NewStyleRule>): Set<string> {
  const names = new Set(usage.names)
  for (const rule of rules) {
    if (rule.kind === 'class') names.add(rule.name)
    for (const token of extractCssSelectorClasses(rule.selector)) names.add(token.name)
  }
  return names
}

function carriedClasses(page: PagePlan): Set<string> {
  const classes = new Set(page.nodeFragment.body?.classIds ?? [])
  for (const node of Object.values(page.nodeFragment.nodes)) {
    for (const name of node.classIds ?? []) classes.add(name)
    if (typeof node.props.svg === 'string') {
      for (const name of classAttributeTokens(node.props.svg)) classes.add(name)
    }
  }
  return classes
}

/** Tokens of every `class="…"` attribute in a markup string. */
function classAttributeTokens(markup: string): string[] {
  const tokens: string[] = []
  for (const match of markup.matchAll(/\bclass\s*=\s*\\?(['"])((?:(?!\1).)*?)\\?\1/gi)) {
    tokens.push(...match[2].split(/\s+/).filter(Boolean))
  }
  return tokens
}

const CLASS_NAME = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/

/**
 * Class names a script may put on an element, read conservatively: every
 * whitespace-separated token of a string or template literal that is a valid
 * class name (`addClass('is-open')`, `{ className: "btn btn--lg" }`, a lookup
 * table of state names, a variable holding a class), plus the classes of any
 * `class="…"` inside HTML the script builds. A selector string such as
 * `'.btn'` or `'[data-x]'` is not a bare class token and does not count.
 * Over-collecting only makes a row default to keeping the rules global.
 */
function scriptClassNames(source: string): Set<string> {
  const names = new Set<string>(classAttributeTokens(source))
  for (const literal of source.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []) {
    for (const token of literal.slice(1, -1).split(/\s+/)) {
      if (CLASS_NAME.test(token)) names.add(token)
    }
  }
  return names
}
