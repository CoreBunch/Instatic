/**
 * Strip dangerous constructs from a parsed HTML Document, mutating it in place,
 * and collect the CSS that the importer re-homes instead of dropping.
 *
 * What is stripped (and counted in StripReport):
 *   - <script> elements               → counted as `scripts`
 *   - Inline event-handler attributes → counted as `inlineHandlers`
 *     (any attribute whose name begins with "on", e.g. onclick, onload)
 *
 * What is removed from the DOM but NOT dropped from the import:
 *   - <style> elements   → their CSS is harvested by `collectStyleCss` (parsed
 *     into editor StyleRules / Selectors-panel entries by the consumer).
 *   - Inline style="…"   → harvested by `harvestInlineStyles` into the node's
 *     first-class `inlineStyles` bag before this removal runs.
 *
 * HTML comments and processing instructions are removed silently.
 */

export interface StripReport {
  scripts: number
  inlineHandlers: number
}

/**
 * Concatenate the text content of every `<style>` element in `doc`. Call this
 * BEFORE `stripUnsafe` removes the `<style>` elements. Empty/whitespace-only
 * blocks are skipped. The consumer parses the result via `cssToStyleRules` so
 * the rules land in the global class registry / Selectors panel.
 */
export function collectStyleCss(doc: Document): string {
  const parts: string[] = []
  for (const el of Array.from(doc.querySelectorAll('style'))) {
    const css = el.textContent ?? ''
    if (css.trim().length > 0) parts.push(closeOpenConstructs(css))
  }
  return parts.join('\n')
}

/**
 * Terminate whatever a `<style>` block left open so it cannot swallow the
 * blocks concatenated after it.
 *
 * A browser parses each `<style>` element as its own stylesheet: an unclosed
 * `@media { ... ` or comment at the end of one block is closed at that
 * block's EOF and never reaches the next element. Concatenating the blocks
 * into one source loses that boundary, so a theme customizer block with one
 * missing `}` would drag every later block of the page inside its `@media`.
 * Appending the missing terminators per block restores the per-element EOF
 * semantics. Stray extra `}` are left alone, as the parser already ignores
 * them at the top level.
 */
export function closeOpenConstructs(css: string): string {
  let depth = 0
  let i = 0
  const n = css.length
  let suffix = ''
  while (i < n) {
    const ch = css[i]!
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end === -1) {
        suffix = '*/'
        break
      }
      i = end + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      let closed = false
      while (j < n) {
        const c = css[j]!
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === ch) {
          closed = true
          break
        }
        // An unescaped newline ends a bad string; the parser recovers there.
        if (c === '\n') break
        j++
      }
      if (!closed && j >= n) {
        suffix = ch
        break
      }
      i = j + 1
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}' && depth > 0) depth--
    i++
  }
  if (suffix === '' && depth === 0) return css
  return css + suffix + '}'.repeat(depth)
}

/**
 * Recursively remove comment nodes (nodeType 8) and processing-instruction
 * nodes (nodeType 7) from the subtree rooted at `node`.
 *
 * Uses the `nextSibling` pattern (capture before removal) so we never skip
 * nodes while mutating the child list.
 */
function removeCommentsAndPIs(node: Node): void {
  let child = node.firstChild
  while (child !== null) {
    const next = child.nextSibling
    if (
      child.nodeType === 8 /* COMMENT_NODE */ ||
      child.nodeType === 7 /* PROCESSING_INSTRUCTION_NODE */
    ) {
      node.removeChild(child)
    } else {
      removeCommentsAndPIs(child)
    }
    child = next
  }
}

/**
 * Strip unsafe constructs from `doc` in place and return counts of what was
 * removed. `<style>` elements and inline `style` attributes are removed too,
 * but their CSS is harvested beforehand (see `collectStyleCss` /
 * `harvestInlineStyles`) so it is preserved, not dropped.
 */
export function stripUnsafe(doc: Document): StripReport {
  const report: StripReport = { scripts: 0, inlineHandlers: 0 }

  // Remove <script> elements first so their content cannot be accessed.
  for (const el of Array.from(doc.querySelectorAll('script'))) {
    el.remove()
    report.scripts++
  }

  // Remove <style> elements — their CSS was already harvested by collectStyleCss.
  for (const el of Array.from(doc.querySelectorAll('style'))) {
    el.remove()
  }

  // Strip event-handler attributes (counted) and the now-harvested inline
  // `style` attribute (not counted — its declarations live on node.inlineStyles).
  // Collect attribute names before removing to avoid NamedNodeMap mutation
  // issues while iterating.
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const toRemove: string[] = []
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on')) {
        toRemove.push(attr.name)
        report.inlineHandlers++
      } else if (attr.name === 'style') {
        toRemove.push(attr.name)
      }
    }
    for (const name of toRemove) {
      el.removeAttribute(name)
    }
  }

  removeCommentsAndPIs(doc)

  return report
}
