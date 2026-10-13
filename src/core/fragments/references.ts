/**
 * Reference walkers shared by extract, plan and resolve.
 *
 * A fragment's portable references all live inside STRING values: media paths
 * (`/uploads/…` in an image `src`, a CSS `url(…)`, a rich-text `<img>`), page
 * links (`cms:page:<id>`), and custom properties (`var(--x)`). Rather than
 * enumerate every prop that might hold one, the walkers visit every string in
 * a node's content, a rule's declarations, or a row's cells, so a reference in
 * an `htmlAttributes` bag or a slot's prop override is found the same way as
 * one in `src`.
 */

import type { PageNode, StyleRule } from '@core/page-tree'

/** Visit every string inside a JSON-like value. */
export function forEachString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) forEachString(item, visit)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) forEachString(item, visit)
  }
}

/**
 * Map every string inside a JSON-like value. Returns the input reference when
 * nothing changed, so callers can cheaply skip untouched objects.
 */
export function mapStrings<T>(value: T, map: (text: string) => string): T {
  if (typeof value === 'string') return map(value) as T
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const mapped = mapStrings(item, map)
      if (mapped !== item) changed = true
      return mapped
    })
    return (changed ? next : value) as T
  }
  if (value && typeof value === 'object') {
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const mapped = mapStrings(item, map)
      if (mapped !== item) changed = true
      next[key] = mapped
    }
    return (changed ? next : value) as T
  }
  return value
}

/** The parts of a node that hold authored content (and so references). */
export function nodeContent(node: PageNode): unknown[] {
  return [node.props, node.breakpointOverrides, node.inlineStyles]
}

/** Return `node` with `map` applied to every string in its content. */
export function mapNodeStrings<TNode extends PageNode>(node: TNode, map: (text: string) => string): TNode {
  const props = mapStrings(node.props, map)
  const breakpointOverrides = mapStrings(node.breakpointOverrides, map)
  const inlineStyles = node.inlineStyles ? mapStrings(node.inlineStyles, map) : undefined
  if (
    props === node.props
    && breakpointOverrides === node.breakpointOverrides
    && inlineStyles === node.inlineStyles
  ) {
    return node
  }
  return {
    ...node,
    props,
    breakpointOverrides,
    ...(inlineStyles ? { inlineStyles } : {}),
  }
}

/** The parts of a style rule that hold declarations. */
export function ruleContent(rule: StyleRule): unknown[] {
  return [rule.styles, rule.contextStyles, rule.rawCss]
}

/** Return `rule` with `map` applied to every declaration string. */
export function mapRuleStrings(rule: StyleRule, map: (text: string) => string): StyleRule {
  const styles = mapStrings(rule.styles, map)
  const contextStyles = mapStrings(rule.contextStyles, map)
  const rawCss = rule.rawCss === undefined ? undefined : map(rule.rawCss)
  if (styles === rule.styles && contextStyles === rule.contextStyles && rawCss === rule.rawCss) {
    return rule
  }
  return { ...rule, styles, contextStyles, ...(rawCss !== undefined ? { rawCss } : {}) }
}

const VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)/g

/** Every `--name` a CSS value reads through `var()`, fallbacks included. */
export function collectVarNames(text: string, into: Set<string>): void {
  for (const match of text.matchAll(VAR_RE)) into.add(match[1])
}

const PAGE_REF_RE = /cms:page:([A-Za-z0-9_-]+)(#[^\s"'<>]*)?/g

/** Every page id a string links to through `cms:page:<id>`. */
export function collectPageRefIds(text: string, into: Set<string>): void {
  for (const match of text.matchAll(PAGE_REF_RE)) into.add(match[1])
}

/**
 * Rewrite `cms:page:<id>` references. `resolve` returns the target page id to
 * link to, or `null` for a page the target site does not have: a value that
 * IS the reference becomes `#` (a safe no-op link, like an unresolvable ref at
 * publish time), and a reference inside longer text (a rich-text `href`)
 * becomes `#` in place.
 */
export function rewritePageRefs(text: string, resolve: (pageId: string) => string | null): string {
  if (!text.includes('cms:page:')) return text
  return text.replace(PAGE_REF_RE, (_match, pageId: string, fragment: string | undefined) => {
    const next = resolve(pageId)
    if (next === null) return '#'
    return `cms:page:${next}${fragment ?? ''}`
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a replacer for a set of literal paths. Longer paths win, so
 * `/uploads/a.jpg.webp` never half-matches `/uploads/a.jpg`.
 */
export function createPathReplacer(replacements: ReadonlyMap<string, string>): (text: string) => string {
  if (replacements.size === 0) return (text) => text
  const paths = [...replacements.keys()].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(paths.map(escapeRegExp).join('|'), 'g')
  return (text) => {
    pattern.lastIndex = 0
    if (!pattern.test(text)) return text
    pattern.lastIndex = 0
    return text.replace(pattern, (match) => replacements.get(match) ?? match)
  }
}

/** Every literal path from `paths` that occurs in `text` (longest first). */
export function createPathFinder(paths: Iterable<string>): (text: string, into: Set<string>) => void {
  const sorted = [...new Set(paths)].filter(Boolean).sort((a, b) => b.length - a.length)
  if (sorted.length === 0) return () => {}
  const pattern = new RegExp(sorted.map(escapeRegExp).join('|'), 'g')
  return (text, into) => {
    for (const match of text.matchAll(pattern)) into.add(match[0])
  }
}
