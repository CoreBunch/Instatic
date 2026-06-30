/**
 * Walk a parsed (and already stripped) DOM Document and map each element to
 * a first-class PageNode via the HTML_TO_MODULE_RULES table.
 *
 * Rules:
 *   - When a recursing container is walked, both its ELEMENT children and its
 *     significant TEXT children are mapped, in document order. Element children
 *     route through the rule table; a text child becomes a synthesized
 *     `base.text` node with `tag: 'none'` so direct text — e.g.
 *     `<div class="num">98%</div>` or `<li>Buy milk</li>` — is preserved
 *     without adding selector-visible wrapper elements. Whitespace-only text
 *     (indentation between tags) and comments are ignored. Leaf rules
 *     (text/link/button/image) capture `textContent` directly and never recurse.
 *   - The first matching rule in HTML_TO_MODULE_RULES is used (guaranteed
 *     to always match because the catch-all '*' rule is last).
 *   - Node creation uses the canonical factory so every produced node is a
 *     valid PageNode: createNode(moduleId, { ...def.defaults, ...ruleProps }).
 *   - class names from el.classList are preserved verbatim on node.classIds.
 *     This layer is registry-agnostic: it writes *names*, not ids. The store
 *     action `insertImportedNodes` reconciles those names into real registry
 *     class ids (linking to <style>-derived rules of the same name, or creating
 *     bare classes for unknown names) as the fragment enters the live tree.
 *   - inline `style="…"` declarations are attached to node.inlineStyles (the
 *     editor's first-class per-node style layer), harvested before stripUnsafe.
 *   - safe authored HTML attributes are preserved as `props.htmlAttributes` on
 *     base modules that emit matching authored elements, so imported CSS/JS and
 *     template runtime hooks keep working after publish. `class` and inline
 *     `style` are handled by first-class node class/style fields instead.
 *
 * Consumers (all call importHtml(source) — the single public entry point):
 *   - Paste-HTML modal (browser-side)
 *   - AI agent insertHtml / replaceNodeHtml tools (browser-side agent executor)
 *   - Full-site Super Import (makeHtmlPagePlan, headless)
 */

import type { PageNode } from '@core/page-tree'
import { createNode } from '@core/page-tree'
import { registry } from '@core/module-engine'
import {
  isRenderableHtmlAttributeName,
  normalizeHtmlAttributeName,
} from '@core/htmlAttributes'
import { HTML_TO_MODULE_RULES } from './rules'
import type { ImportRule } from './rules'
import { parseHtml } from './parseHtml'
import { stripUnsafe, collectStyleCss } from './stripUnsafe'
import type { StripReport } from './stripUnsafe'
import { harvestInlineStyles } from './inlineStyle'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A flat NodeTree fragment of real PageNodes. Children are ID strings, matching
 * the rest of the engine's NodeTree<PageNode> shape.
 */
export interface ImportFragment {
  /** All produced nodes keyed by id. */
  nodes: Record<string, PageNode>
  /** IDs of the document-order top-level nodes (doc.body element children). */
  rootIds: string[]
  /** Attributes that belonged to the source `<body>` element itself. */
  body?: ImportBodyAttributes
}

interface ImportBodyAttributes {
  classIds?: string[]
  inlineStyles?: Record<string, string>
  props?: Record<string, unknown>
}

/** The result returned by the convenience entry point importHtml(). */
export interface ImportResult extends ImportFragment {
  /** Counts of constructs stripped by stripUnsafe(). */
  stripped: StripReport
  /**
   * Raw concatenated CSS harvested from `<style>` blocks in the source. Empty
   * when the source had none. The consumer parses it via `cssToStyleRules`
   * (where the site's breakpoints are available) and commits the resulting
   * rules to the global class registry / Selectors panel.
   */
  styleCss: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// DOM nodeType constants. Spelled numerically so this module needs no `Node`
// global (it runs in the browser bundle and under the happy-dom test polyfill).
const ELEMENT_NODE = 1
const TEXT_NODE = 3
const HTML_ATTRIBUTE_MODULES = new Set([
  'base.container',
  'base.text',
  'base.link',
  'base.button',
  'base.image',
])

const MODULE_GENERATED_ATTRIBUTE_NAMES: Record<string, readonly string[]> = {
  'base.button': ['aria-disabled', 'disabled', 'href', 'rel', 'target', 'type'],
  'base.image': [
    'alt',
    'decoding',
    'fetchpriority',
    'height',
    'loading',
    'sizes',
    'src',
    'srcset',
    'style',
    'width',
  ],
  'base.link': ['href', 'rel', 'target'],
}

/**
 * Mutable accumulator threaded through the recursive walk.
 *
 * - `nodes` is written as elements are mapped.
 * - `inlineStyles` is the read-only harvest of inline `style="…"` declarations
 *   keyed by the source element (see `harvestInlineStyles`), looked up per
 *   element and written onto the produced node's `inlineStyles`.
 */
interface WalkContext {
  nodes: Record<string, PageNode>
  inlineStyles: Map<Element, Record<string, string>>
  /**
   * True inside a `<pre>` subtree, where whitespace (incl. newlines) is
   * significant and must be preserved verbatim. Outside, whitespace is
   * collapsed the way normal HTML flow renders it.
   */
  preserveWs: boolean
}

/**
 * Find the first rule whose selector matches `el`. Always returns a rule
 * because the last rule in the table uses the catch-all '*' selector.
 */
function matchRule(el: Element): ImportRule {
  for (const rule of HTML_TO_MODULE_RULES) {
    if (el.matches(rule.match)) return rule
  }
  // Unreachable: the catch-all '*' rule always matches every element.
  return HTML_TO_MODULE_RULES[HTML_TO_MODULE_RULES.length - 1]!
}

function collectHtmlAttributes(el: Element, moduleId?: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const generatedNames = new Set(MODULE_GENERATED_ATTRIBUTE_NAMES[moduleId ?? ''] ?? [])
  for (const attr of Array.from(el.attributes)) {
    const name = normalizeHtmlAttributeName(attr.name)
    if (generatedNames.has(name)) continue
    if (!isRenderableHtmlAttributeName(name)) continue
    attrs[name] = attr.value
  }
  return attrs
}

function collectElementProps(el: Element, moduleId?: string): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  const htmlAttributes = collectHtmlAttributes(el, moduleId)
  if (Object.keys(htmlAttributes).length > 0) props.htmlAttributes = htmlAttributes
  return props
}

function collectBodyAttributes(
  body: HTMLElement,
  inlineStyles: Map<Element, Record<string, string>>,
): ImportBodyAttributes | undefined {
  const bodyAttrs: ImportBodyAttributes = {}
  const classIds = Array.from(body.classList)
  if (classIds.length > 0) bodyAttrs.classIds = classIds

  const props = collectElementProps(body)
  if (Object.keys(props).length > 0) bodyAttrs.props = props

  const inline = inlineStyles.get(body)
  if (inline && Object.keys(inline).length > 0) bodyAttrs.inlineStyles = inline

  return Object.keys(bodyAttrs).length > 0 ? bodyAttrs : undefined
}

/**
 * Build a synthesized no-wrapper `base.text` node for a bare text node's
 * content. Direct text inside a recursing container has no element of its own,
 * so it would otherwise be dropped — leaving an empty container. It publishes
 * back to a literal DOM text node so imported selector behavior stays faithful.
 * Returns the new node's id after registering it in `nodes`.
 */
function createTextNode(text: string, ctx: WalkContext): string {
  const def = registry.getOrThrow('base.text')
  const node = createNode('base.text', { ...def.defaults, text, tag: 'none' })
  ctx.nodes[node.id] = node
  return node.id
}

/**
 * Map the child nodes of `parent` (an element being recursed into, or
 * `doc.body` at the top level) to PageNode ids in document order:
 *   - ELEMENT children route through the rule table via processElement.
 *   - significant TEXT children become synthesized no-wrapper base.text nodes.
 *   - whitespace-only text and comments are skipped.
 *
 * Mutually recursive with processElement (function declarations are hoisted,
 * so definition order doesn't matter).
 */
type ChildItem = { kind: 'el'; el: Element } | { kind: 'text'; text: string }

function mapChildNodes(parent: Element, ctx: WalkContext): string[] {
  // Inside <pre>: whitespace and newlines are significant — keep every text
  // node verbatim so terminal/code blocks retain their line structure (the
  // `white-space: pre` class then renders the newlines).
  if (ctx.preserveWs) {
    const ids: string[] = []
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === ELEMENT_NODE) {
        ids.push(processElement(child as Element, ctx))
      } else if (child.nodeType === TEXT_NODE) {
        const raw = child.textContent ?? ''
        if (raw.length > 0) ids.push(createTextNode(raw, ctx))
      }
    }
    return ids
  }

  // Normal flow: collapse whitespace the way the browser renders it.
  //   - runs of whitespace → a single space,
  //   - a whitespace-only node containing a newline = pretty-print indentation
  //     between block elements → dropped,
  //   - a whitespace-only node WITHOUT a newline = a significant inline space
  //     (e.g. `</span> <span>`) → kept as one space,
  //   - leading/trailing space at the block's edges is insignificant → trimmed.
  // This keeps inline spacing intact (`Bold <strong>word</strong> here` →
  // "Bold word here") while not surfacing stray indentation in text fields.
  const items: ChildItem[] = []
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === ELEMENT_NODE) {
      items.push({ kind: 'el', el: child as Element })
    } else if (child.nodeType === TEXT_NODE) {
      const raw = child.textContent ?? ''
      if (/^\s*$/.test(raw)) {
        if (/[\n\r]/.test(raw)) continue // indentation between block tags
        items.push({ kind: 'text', text: ' ' }) // significant inline space
      } else {
        items.push({ kind: 'text', text: raw.replace(/\s+/g, ' ') })
      }
    }
  }

  // Trim only the parent element's true leading/trailing text edges. A text
  // run that follows or precedes an element is mixed-content spacing and must
  // keep its collapsed boundary space (`<span>A</span> B`).
  if (items[0]?.kind === 'text') {
    items[0] = { kind: 'text', text: items[0].text.replace(/^\s+/, '') }
  }
  const last = items[items.length - 1]
  if (last?.kind === 'text') {
    items[items.length - 1] = { kind: 'text', text: last.text.replace(/\s+$/, '') }
  }

  const childIds: string[] = []
  for (const it of items) {
    if (it.kind === 'el') {
      childIds.push(processElement(it.el, ctx))
    } else if (it.text.length > 0) {
      childIds.push(createTextNode(it.text, ctx))
    }
  }
  return childIds
}

/**
 * Map a single DOM element to a PageNode, recursing into its children if the
 * matched rule has `recurse: true`. Adds the produced node (and all
 * descendants) to `nodes` keyed by id.
 *
 * Returns the id of the node produced for `el`.
 */
function processElement(el: Element, ctx: WalkContext): string {
  const rule = matchRule(el)
  const { moduleId, props: ruleProps } = rule.map(el)
  const props = { ...ruleProps }
  if (HTML_ATTRIBUTE_MODULES.has(moduleId)) {
    Object.assign(props, collectElementProps(el, moduleId))
  }

  // Merge module defaults with rule-specific props so every node starts
  // from a well-formed baseline.
  const def = registry.getOrThrow(moduleId)
  const node = createNode(moduleId, { ...def.defaults, ...props })

  // Preserve element class *names* verbatim. This layer is registry-agnostic
  // (it has no SiteDocument), so it cannot mint real class ids here. The store
  // action `insertImportedNodes` links these names to registry class ids (and
  // auto-creates bare classes for unknown names) when the fragment is inserted.
  node.classIds = Array.from(el.classList)

  // Attach the element's inline `style="…"` declarations (harvested before
  // stripUnsafe removed the `style` attribute) as the node's inline styles —
  // the editor's first-class per-node `style=""` layer.
  const inline = ctx.inlineStyles.get(el)
  if (inline) node.inlineStyles = inline

  const shouldRecurse =
    typeof rule.recurse === 'function' ? rule.recurse(el) : Boolean(rule.recurse)
  if (shouldRecurse) {
    // Walk childNodes (not just children) so direct text is preserved in
    // document order. Without this, `<div class="num">98%</div>` and
    // `<li>Buy milk</li>` import as empty containers because their text
    // content isn't an element.
    // Entering a <pre> switches the subtree to whitespace-preserving mode.
    const childCtx =
      ctx.preserveWs || el.tagName.toLowerCase() === 'pre'
        ? { ...ctx, preserveWs: true }
        : ctx
    node.children = mapChildNodes(el, childCtx)
    // A node that recursed into real child nodes must NOT also keep a flattened
    // `text` prop: the children (including synthesized base.text for direct
    // text) are the source of truth. Without this, an element that both sets
    // `text` in its rule and recurses on element children (e.g. a `<a>` wrapping
    // tokens/spans) double-represents its content — ambiguous and can
    // double-render. Mirrors the conditional heading/label rules.
    if (node.children.length > 0 && 'text' in node.props) {
      delete (node.props as Record<string, unknown>).text
    }
  }

  ctx.nodes[node.id] = node
  return node.id
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Walk doc.body's child nodes and map each to a PageNode via
 * HTML_TO_MODULE_RULES. Returns a flat fragment (nodes map + root IDs) that
 * callers splice into the live page tree. Top-level bare text is preserved as
 * a root base.text node, mirroring nested handling.
 *
 * Expects that `doc` has already been through `stripUnsafe()` — call
 * `importHtml()` to run both steps together.
 */
export function walkAndMap(
  doc: Document,
  inlineStyles: Map<Element, Record<string, string>> = new Map(),
): ImportFragment {
  const ctx: WalkContext = { nodes: {}, inlineStyles, preserveWs: false }

  if (!doc.body) return { nodes: ctx.nodes, rootIds: [] }

  const rootIds = mapChildNodes(doc.body, ctx)
  const body = collectBodyAttributes(doc.body, inlineStyles)

  return { nodes: ctx.nodes, rootIds, ...(body ? { body } : {}) }
}

/**
 * The single entry point for every consumer: parse → harvest → strip → walk.
 *
 * 1. parseHtml  — DOMParser.parseFromString (global, browser or test polyfill)
 * 2. harvestInlineStyles — capture each element's inline `style="…"` bag, and
 *    collectStyleCss — capture every `<style>` block's CSS, BOTH before step 4
 *    removes the `style` attribute and the `<style>` elements
 * 3. (within walkAndMap) attach the harvested inline bag to each node
 * 4. stripUnsafe — removes <script>, <style>, inline event handlers, style=""
 * 5. walkAndMap  — maps every element to a PageNode via HTML_TO_MODULE_RULES,
 *    attaching the harvested inline styles to its node's `inlineStyles`
 *
 * Returns an ImportResult that merges the fragment with the StripReport and the
 * raw `<style>` CSS, so callers can parse the CSS into registry rules and
 * surface a "Stripped: N scripts, M handlers" toast.
 */
export function importHtml(source: string): ImportResult {
  const doc = parseHtml(source)
  // Harvest inline styles + <style> CSS before stripUnsafe drops them.
  const inlineStyles = harvestInlineStyles(doc)
  const styleCss = collectStyleCss(doc)
  const stripped = stripUnsafe(doc)
  const fragment = walkAndMap(doc, inlineStyles)
  return { ...fragment, stripped, styleCss }
}
