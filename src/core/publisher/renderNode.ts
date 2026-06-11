/**
 * Publisher — recursive node renderer.
 *
 * `renderNode` is the entry point for the bottom-up walk. Two paths:
 *
 *   1. Specialised renderers (looked up by moduleId) for nodes whose
 *      semantics replace the normal walk — `base.visual-component-ref`
 *      (inlines a Visual Component tree) and `base.loop` (iterates a data
 *      source and round-robins its child variants).
 *   2. Standard bottom-up flow in `renderStandardNode`: render children →
 *      resolve effective + dynamic props → escape → attach derived assets
 *      → call module.render() → collect deduped CSS → inject author classes.
 *
 * Specialised renderers receive `renderNode` as a callback so the file
 * graph stays acyclic — only this file knows both ends of the recursion.
 *
 * Constraint #211: escapeProps() is called on every node before render().
 * Constraint #179: module render() is a pure function — no DOM, no React,
 * no side effects.
 * Decision #308: CSS dedup keyed by moduleId reduces published CSS by
 * ~60–80% on typical pages.
 */

import type { PageNode } from '@core/page-tree'
import { isPageRef, resolvePageRef } from '@core/page-tree'
import type { AnyModuleDefinition } from '@core/module-engine'
import { validateNodeProps } from '@core/module-engine'
import { resolveProps } from '@core/page-tree'
import { resolveDynamicProps } from '@core/templates/dynamicBindings'
import { sanitizeModuleCSS } from './cssCollector'
import { escapeHtml } from './utils'
import { escapeProps } from './escapeProps'
import { injectNodeClassIds, injectNodeId, injectNodeInlineStyles } from './classInjection'
import { renderVisualComponentRef } from './renderVisualComponentRef'
import { renderLoop } from './renderLoop'
import { resolveAutoSizes } from './sizesResolver'
import { sanitizeRichtext } from '@core/sanitize'
import type {
  RenderConfig,
  RenderAccumulators,
  RenderNodeFn,
  RenderResolvedMedia,
} from './renderConfig'

/**
 * Attach every resolved media asset on this node, keyed by prop key, so
 * modules with multiple media props (e.g. base.video with `videoUrl` +
 * `poster`) can read each one independently. The render() boundary preserves
 * non-string values, so `_resolvedMediaByKey` survives `escapeProps` untouched.
 *
 * Render functions read `props._resolvedMediaByKey?.<propKey>` and fall back
 * to the raw prop string when it's absent — for non-CMS URLs, pages built
 * before the prefetch ran, or the editor canvas preview that doesn't run
 * the prefetch.
 */
/**
 * Resolve any string prop that is an internal page reference
 * (`cms:page:<id>`) to the target page's current public path. Generic over all
 * props so any module's URL-shaped prop (link/button `href`, …) resolves
 * without each render() needing site access. Non-ref values pass through
 * untouched; a ref to a missing page becomes `#`.
 */
function resolvePageRefProps(
  props: Record<string, unknown>,
  pages: RenderConfig['site']['pages'],
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null
  for (const [key, value] of Object.entries(props)) {
    if (!isPageRef(value)) continue
    const resolved = resolvePageRef(value, pages)
    if (resolved === null) continue
    if (!out) out = { ...props }
    out[key] = resolved
  }
  return out ?? props
}

function attachResolvedMediaByKey(
  safeProps: Record<string, unknown>,
  def: AnyModuleDefinition,
  resolvedProps: Record<string, unknown>,
  mediaAssets: ReadonlyMap<string, RenderResolvedMedia> | undefined,
): void {
  if (!mediaAssets || mediaAssets.size === 0) return
  const byKey: Record<string, RenderResolvedMedia> = {}
  for (const [propKey, control] of Object.entries(def.schema)) {
    if (control.type !== 'image' && control.type !== 'media') continue
    const value = resolvedProps[propKey]
    if (typeof value !== 'string') continue
    const resolved = mediaAssets.get(value)
    if (resolved) byKey[propKey] = resolved
  }
  if (Object.keys(byKey).length > 0) {
    safeProps._resolvedMediaByKey = byKey
  }
}

/**
 * Pre-resolve `sizes='auto'` on image modules by walking the ancestor chain
 * for an explicit pixel-valued cap (typically a parent container's
 * `max-width`). The resolved string lands on `props._resolvedAutoSizes`. The
 * module's render() reads it next to its own `sizes` prop and emits the
 * result as the final `sizes` attribute. Cheap on most pages: the resolver
 * caches the parent map per Page and short-circuits as soon as it finds a
 * constraining ancestor.
 */
function attachResolvedAutoSizes(
  safeProps: Record<string, unknown>,
  def: AnyModuleDefinition,
  node: PageNode,
  resolvedProps: Record<string, unknown>,
  config: RenderConfig,
): void {
  if (resolvedProps['sizes'] !== 'auto') return
  const hasImageProp = Object.values(def.schema).some((c) => c.type === 'image')
  if (!hasImageProp) return
  const resolvedSizes = resolveAutoSizes(node.id, config.page, config.site)
  if (resolvedSizes) {
    safeProps._resolvedAutoSizes = resolvedSizes
  }
}

/**
 * Standard bottom-up render path: children first, then resolve props, attach
 * resolved assets, call the module's pure render(), collect deduped CSS,
 * inject author classes onto the root element.
 *
 * `base.body` emits no wrapper element — its render returns naked children
 * HTML — so there's nothing to inject classes onto here. Root-level classIds
 * are applied to `<body>` by `publishPage` instead.
 */
function renderStandardNode(
  node: PageNode,
  def: AnyModuleDefinition,
  config: RenderConfig,
  acc: RenderAccumulators,
): string {
  const renderedChildren = (node.children ?? []).map((childId) => renderNode(childId, config, acc))

  // Resolve effective props (base + breakpoint shallow-merge for
  // breakpointOverridable schema keys only — content props always publish
  // their base value because HTML is a single document) and apply dynamic
  // template bindings.
  const effectiveProps = resolveProps(node, config.breakpointId, def.schema)
  const dynamicProps = resolveDynamicProps(
    effectiveProps,
    node.dynamicBindings,
    config.templateContext,
  )

  // Resolve internal page references (`cms:page:<id>`) to the target page's
  // CURRENT public path, so links survive slug renames. Runs before validation
  // / escaping so the resolved URL flows through the normal href pipeline.
  const resolvedProps = resolvePageRefProps(dynamicProps, config.site.pages)

  // Coerce/default-fill authored props against the module's TypeBox schema
  // (soft boundary — never throws; unknown injected keys survive the merge).
  const validatedProps = validateNodeProps(def, resolvedProps)

  // Escape all string props (Constraint #211) before calling render(), then
  // attach derived assets that survive the escape boundary unchanged.
  const safeProps = escapeProps(validatedProps, def.schema)
  attachResolvedMediaByKey(safeProps, def, validatedProps, config.mediaAssets)
  attachResolvedAutoSizes(safeProps, def, node, validatedProps, config)

  const output = def.render(safeProps as never, renderedChildren)

  // CSS dedup — one entry per moduleId. Sanitize before storage to neutralise
  // any `</style` so the HTML5 RAWTEXT tokenizer cannot escape the
  // surrounding <style> block (Constraint #228).
  if (output.css && !acc.cssMap.has(node.moduleId)) {
    acc.cssMap.set(node.moduleId, sanitizeModuleCSS(output.css))
  }

  // JS dedup — one entry per moduleId, mirroring CSS. No escaping needed:
  // module JS is served as an external file (`/_instatic/module-js/<id>.js`),
  // never inlined into the document.
  if (output.js && !acc.jsMap.has(node.moduleId)) {
    acc.jsMap.set(node.moduleId, output.js)
  }

  // base.body has no wrapper element — its classIds + inline styles go on
  // <body> in publishPage.
  if (node.moduleId === 'base.body') return output.html
  const withClasses = injectNodeClassIds(output.html, node.classIds, config.site)
  const withStyles = injectNodeInlineStyles(withClasses, node.inlineStyles)
  return config.annotateNodeIds ? injectNodeId(withStyles, node.id) : withStyles
}

/**
 * Emit a `<instatic-hole>` placeholder for a dynamic node.
 *
 * The subtree is NOT rendered — the hole runtime fetches it at request time
 * when the element approaches the viewport. The optional `staticPlaceholder`
 * from the module definition is sanitised and baked in so non-JS visitors see
 * a meaningful fallback (skeleton, "Loading…" text, etc.).
 *
 * Sanitisation: `sanitizeRichtext` is called on the placeholder string.
 * The Bun server configures an explicit DOMPurify runtime at boot, so safe
 * semantic fallback markup is preserved while scripts, event handlers, and
 * unsafe URLs are stripped before they reach the page artefact.
 */
function renderHolePlaceholder(
  node: PageNode,
  def: AnyModuleDefinition,
  config: RenderConfig,
  acc: RenderAccumulators,
): string {
  // Track which nodes actually became holes so render.ts can decide whether to
  // inject the hole runtime script based on real rendered output.
  acc.holeNodeIds.add(node.id)

  const rawPlaceholder = def.staticPlaceholder?.(node.props as never) ?? ''
  const sanitized = rawPlaceholder ? sanitizeRichtext(rawPlaceholder) : ''

  const safeId = escapeHtml(node.id)
  const version = config.publishVersion ?? 0

  return (
    `<instatic-hole id="hole-${safeId}" data-instatic-hole="${safeId}" data-instatic-version="${version}" style="display:contents">` +
    sanitized +
    `</instatic-hole>`
  )
}

type SpecialRenderer = (
  node: PageNode,
  config: RenderConfig,
  acc: RenderAccumulators,
  renderNode: RenderNodeFn,
) => string

/**
 * Publisher-side specialised-renderer IMPLEMENTATIONS, keyed by moduleId. Each
 * replaces the entire "render children → resolve props → call render() → inject
 * classes" flow because the moduleId's semantics need a different shape:
 *
 * - `base.visual-component-ref`: inlines a Visual Component tree recursively,
 *   consuming its `base.slot-instance` children for slot fills.
 * - `base.loop`: iterates a `LoopEntitySource` and renders its child template
 *   once per item with a freshly pushed entry-stack frame.
 *
 * Each takes `renderNode` as a callback so the file graph stays acyclic, and
 * each bypasses the standard pure-render boundary — so the implementation MUST
 * live here in the publisher. The registry only declares WHICH modules are
 * special (via `publishBehavior: 'special'`); this map supplies the matching
 * implementation. Adding a new special render path is a single map entry plus
 * `publishBehavior: 'special'` on the module definition.
 */
const SPECIAL_RENDERER_IMPLS: ReadonlyMap<string, SpecialRenderer> = new Map([
  ['base.visual-component-ref', renderVisualComponentRef],
  ['base.loop', renderLoop],
])

/** The moduleIds the publisher provides a specialised renderer for. */
export function getSpecialRendererModuleIds(): string[] {
  return [...SPECIAL_RENDERER_IMPLS.keys()]
}

/**
 * Resolve the specialised renderer for a node. A `publishBehavior: 'special'`
 * declaration on the module definition is the contract that this dispatch
 * exists — `getSpecialRendererModuleIds()` must stay in sync with the set of
 * registered modules declaring `'special'` (enforced by test). Declaring
 * `'special'` with NO matching publisher implementation is a programming error
 * and throws here, so a forgotten renderer fails loudly instead of silently
 * falling through to the standard (wrong) render path.
 */
export function resolveSpecialRenderer(
  def: AnyModuleDefinition,
): SpecialRenderer | undefined {
  const impl = SPECIAL_RENDERER_IMPLS.get(def.id)
  if (def.publishBehavior === 'special' && !impl) {
    throw new Error(
      `[publisher] Module "${def.id}" declares publishBehavior:'special' but no specialised renderer is registered for it.`,
    )
  }
  return impl
}

/**
 * Render a single node and its entire subtree recursively.
 *
 * @returns HTML string for this node and all its descendants
 */
export function renderNode(
  nodeId: string,
  config: RenderConfig,
  acc: RenderAccumulators,
): string {
  const node = config.page.nodes[nodeId]
  if (!node) return ''
  if (node.hidden) return ''

  const def = config.registry.get(node.moduleId)
  if (!def) {
    // Unknown module — emit a comment so the page doesn't silently lose content
    return `<!-- instatic: unknown module "${escapeHtml(node.moduleId)}" -->`
  }

  // Layer C: when this node id is in the dynamic set, emit a <instatic-hole>
  // placeholder and do NOT recurse into the subtree. The hole runtime will
  // fetch the full rendered fragment at request time via /_instatic/hole/<nodeId>.
  if (config.dynamicNodeIds?.has(nodeId)) {
    return renderHolePlaceholder(node, def, config, acc)
  }

  const specialRenderer = resolveSpecialRenderer(def)
  if (specialRenderer) return specialRenderer(node, config, acc, renderNode)

  return renderStandardNode(node, def, config, acc)
}
