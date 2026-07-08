/**
 * CssCollector — accumulates CSS from rendered nodes, deduplicating by moduleId.
 *
 * Why moduleId-keyed deduplication?
 * ─────────────────────────────────
 * A typical page might contain 50 instances of "base.text".
 * Without dedup, every instance emits an identical CSS block → 50× overhead.
 *
 * With moduleId keying:
 * - 200-node page → at most N_unique_module_types CSS entries
 * - At 200 nodes (average 8 unique module types), this reduces published CSS by ~60–80%
 *   vs naive concatenation of every node's css output.
 * - Lookup/insert is O(1) per node (Map key = moduleId string).
 *
 * Raw CSS-string deduplication would also work but costs an O(n) hash per node.
 * moduleId keying is strictly faster for the common case (same module, same CSS).
 *
 * Reference: Performance analysis in Contribution #308.
 */

import type { SiteDocument } from '@core/page-tree'
import { isGeneratedClass } from '@core/page-tree'
import { generateClassCSS } from './classCss'
import type { ResponsiveCssOptions } from './responsiveBackground'

/**
 * Collect all user-authored CSS class declarations for the classes referenced
 * across a site's pages and VC trees. Framework-generated utilities are
 * emitted through `framework.css` by `generateFrameworkCss()` instead.
 *
 * Only emits CSS for classes actually used by at least one node (tree-shaking).
 * Traverses both page nodes (flat map) and VisualComponent flat tree nodes
 * so that classes used inside VCs are also included.
 * Sanitised via sanitizeModuleCSS (Constraint #228).
 *
 * @param site The site containing the class registry, page nodes, and VCs.
 * @returns A CSS string of all used class-name rules, or empty string if none.
 */
export function collectClassCSS(site: SiteDocument, options: ResponsiveCssOptions = {}): string {
  // Defensive guard: corrupted/partial snapshots may have classes undefined
  if (!site.styleRules) return ''

  // Collect the set of used classIds across all pages
  const usedClassIds = new Set<string>()
  for (const page of site.pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.classIds) {
        for (const id of node.classIds) {
          usedClassIds.add(id)
        }
      }
    }
  }

  // Also collect classIds from all VisualComponent trees. VC nodes are rendered
  // inline by the publisher (renderVisualComponentRef) but live outside page.nodes —
  // their classIds must be collected separately so the CSS rules are included.
  if (site.visualComponents) {
    for (const vc of site.visualComponents) {
      // VC-level classIds (the component container)
      if (vc.classIds) {
        for (const id of vc.classIds) {
          usedClassIds.add(id)
        }
      }
      // Collect from the VC's flat node tree
      for (const node of Object.values(vc.tree.nodes)) {
        if (node.classIds) {
          for (const id of node.classIds) {
            usedClassIds.add(id)
          }
        }
      }
    }
  }

  // Build the filtered set of style rules to emit. Two contributions:
  //   1. class-kind rules referenced by any node's classIds (tree-shaken).
  //   2. EVERY ambient-kind rule (e.g. `h1`, `.hero .title`, `a:hover`) —
  //      ambient rules attach by CSS matching, not by node assignment, so
  //      tree-shaking by classIds would silently drop them.
  // Framework-generated utility classes are excluded here; they ride through
  // `framework.css` via `generateFrameworkCss()`.
  const usedClasses: SiteDocument['styleRules'] = {}
  for (const id of usedClassIds) {
    const cls = site.styleRules[id]
    if (!cls || isGeneratedClass(cls)) continue
    if (cls.kind && cls.kind !== 'class') continue // ambient ids never land here
    usedClasses[id] = cls
  }
  for (const cls of Object.values(site.styleRules)) {
    if (cls.kind !== 'ambient') continue
    if (isGeneratedClass(cls)) continue
    usedClasses[cls.id] = cls
  }

  if (Object.keys(usedClasses).length === 0) return ''

  const css = generateClassCSS(usedClasses, site.breakpoints, site.conditions ?? [], options)
  return sanitizeModuleCSS(css)
}

/**
 * Neutralise any `</style` sequence in CSS before injection into a `<style>` block.
 *
 * Constraint #228: module CSS is inserted directly between `<style>…</style>` tags.
 * A module that returns `css: 'h1{color:red}</style><script>…</script><style>'`
 * would break out of the style block and inject arbitrary HTML/script.
 *
 * The HTML5 RAWTEXT tokenizer recognises an end-tag for `<style>` whenever
 * `</style` is followed by U+0009/000A/000C/0020 (whitespace), U+002F (`/`),
 * or U+003E (`>`). A simple `</style\s*>` strip therefore misses the slash
 * terminator forms `</style/>`, `</style /…>`, `</style/foo>`. Instead we
 * insert a backslash inside the bigram, turning `</style…` into `<\/style…`.
 * `<` followed by `\` (not `/`) keeps the parser in RAWTEXT data state, so
 * the end-tag is never recognised regardless of trailer (`>`, `/`, whitespace,
 * EOF). CSS string literals resolve `\/` back to `/`, so any author-intended
 * URL value such as `url("…</style…")` round-trips identically.
 *
 * CWE-79 (XSS via style block escape).
 */
export function sanitizeModuleCSS(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style')
}

export class CssCollector {
  private readonly seen = new Map<string, string>()

  /**
   * Add CSS for a module type. If this moduleId has already been added,
   * the new CSS is silently ignored (first-write-wins per module type).
   * CSS is sanitized via sanitizeModuleCSS() before storage (Constraint #228).
   */
  add(moduleId: string, css: string): void {
    if (!this.seen.has(moduleId)) {
      this.seen.set(moduleId, sanitizeModuleCSS(css))
    }
  }

  /** Return all collected CSS joined into a single string. */
  collect(): string {
    return Array.from(this.seen.values()).join('\n')
  }

  /** Number of unique module types that contributed CSS. */
  get size(): number {
    return this.seen.size
  }

  /** True if no CSS has been collected. */
  get isEmpty(): boolean {
    return this.seen.size === 0
  }

  /** Reset the collector for reuse. */
  clear(): void {
    this.seen.clear()
  }
}
