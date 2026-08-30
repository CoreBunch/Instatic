/**
 * Publisher — `base.loop` iteration renderer.
 *
 * Specialised renderer for loop nodes. The loop iterates its resolved data
 * and round-robins over the loop's children — child i renders item i,
 * pushing each item onto the template entry stack so dynamic bindings
 * inside the body resolve against the loop entry.
 *
 * Takes `renderNode` as a parameter rather than importing it directly so
 * the file graph stays acyclic — the dispatcher in `renderNode.ts` is the
 * only thing that knows both ends of the recursion.
 */

import type { PageNode } from '@core/page-tree'
import {
  ENTRY_FIELD_FILTER_KEY,
  ENTRY_FIELD_SOURCE_ID,
  resolveEntryFieldItems,
  type EntryFieldMedia,
  type LoopItem,
} from '@core/loops'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { resolveHtmlTag } from '@modules/base/utils/htmlTag'
import { htmlAttributesAttr } from './htmlAttributesEmit'
import { injectNodeClassIds, injectNodeId, injectNodeInlineStyles } from './classInjection'
import { escapeHtml } from './utils'
import type { RenderConfig, RenderAccumulators, RenderNodeFn } from './renderConfig'

/**
 * Render a `base.loop` node by iterating its resolved data and round-robining
 * over the loop's children.
 *
 * For a loop with N children and M items, iteration `i` (0-indexed) renders
 * the loop's child at index `i mod N` with the loop's `entryStack` extended
 * by the iteration's item. Two children → alternating layouts; three →
 * cycle of three; etc. Each iteration renders against a FRESH child
 * `RenderConfig` whose `templateContext.entryStack` is a new array
 * `[...baseStack, item]` — there is no in-place push/pop on a shared array, so
 * a VC ref (or nested loop) rendered inside the body sees an immutable
 * per-iteration snapshot rather than a live, mutating list. The loop's
 * siblings keep seeing the outer template entry because the outer config is
 * never touched.
 *
 * Loops without resolved data (server pre-fetch failed, source unregistered,
 * or no data context like in editor canvas tests) render an HTML comment so
 * the page doesn't silently lose layout. Empty result sets render as empty
 * string — author can wrap the loop in a Container to apply "if empty, hide
 * the section" patterns later.
 *
 * Pagination:
 *   - 'none': all rendered items emitted, no extra markup.
 *   - 'infinite': items emitted, plus a `data-instatic-loop-id` sentinel and the
 *     loop's nodeId is added to `acc.infiniteLoopIds` so the publisher can
 *     inject the runtime script. The runtime fetches subsequent pages from
 *     `/_instatic/loop/<loopId>?page=N` and appends rendered HTML.
 *
 * The loop's own `classIds` are injected onto a wrapping `<div>` so author-
 * applied classes (e.g. grid layout) actually take effect.
 */
export function renderLoop(
  node: PageNode,
  config: RenderConfig,
  acc: RenderAccumulators,
  renderNode: RenderNodeFn,
): string {
  const loopId = node.id
  const data = resolveLoopData(node, config)
  // No pre-fetched data — most likely an editor preview or a test that did
  // not seed loopData. Emit a marker comment rather than an empty string so
  // diagnostics in the rendered output are visible.
  if (!data) {
    return `<!-- instatic: loop "${escapeHtml(loopId)}" has no resolved data -->`
  }

  const variants = node.children ?? []
  if (variants.length === 0) {
    return '<!-- instatic: loop has no child template -->'
  }
  if (data.items.length === 0) {
    return ''
  }

  // The base template context (page/site/route frames + the outer entry stack)
  // that loop-body bindings resolve against. Each iteration derives a CHILD
  // config from this WITHOUT mutating it — see below.
  const baseTemplateContext: TemplateRenderDataContext = config.templateContext ?? { entryStack: [] }
  const baseStack = baseTemplateContext.entryStack

  let body = ''
  data.items.forEach((item: LoopItem, i: number) => {
    const variantId = variants[i % variants.length]
    // Per-iteration snapshot: a NEW entryStack array with this item appended,
    // wrapped in a NEW templateContext and a NEW child config. Nothing the
    // outer config owns is mutated, so iterations are independent and a VC ref
    // (or nested loop) in the body sees a stable, item-specific stack.
    const iterationTemplateContext: TemplateRenderDataContext = {
      ...baseTemplateContext,
      entryStack: [...baseStack, item],
    }
    const iterationConfig: RenderConfig = {
      ...config,
      templateContext: iterationTemplateContext,
    }
    body += renderNode(variantId, iterationConfig, acc)
  })

  // Pagination signals — pagination='infinite' attaches a sentinel and
  // registers the loop's id so publishPage() can decide whether to emit
  // the runtime script.
  const props = node.props
  const isInfinite = props.pagination === 'infinite'
  let attrs = ` data-instatic-loop="${escapeHtml(loopId)}"`
  attrs += ` data-instatic-loop-page="${data.pageNumber}"`
  if (isInfinite) {
    attrs += ` data-instatic-loop-mode="infinite"`
    attrs += ` data-instatic-loop-has-more="${data.hasMore ? 'true' : 'false'}"`
    attrs += ` data-instatic-loop-page-size="${typeof props.pageSize === 'number' ? Math.floor(props.pageSize) : 10}"`
    acc.infiniteLoopIds.add(loopId)
  }

  // Author attributes — normalised, escaped, and filtered by the shared
  // sanitiser, which reserves the `data-instatic-*` prefix so the loop's own
  // bookkeeping above can't be redirected from the attributes panel.
  attrs += htmlAttributesAttr(props.htmlAttributes)

  // Wrapper element — author-selectable via the shared htmlTag helper
  // (defaults to 'div'). `resolveHtmlTag` always returns a safe lowercase
  // tag name, so it's already escape-safe for interpolation.
  const tag = resolveHtmlTag(props.tag, props.customTag)
  const html = `<${tag}${attrs}>${body}</${tag}>`

  // Inject the loop's own classIds + inline styles onto the wrapper element.
  const withClasses = injectNodeClassIds(html, node.classIds, config.site)
  const withStyles = injectNodeInlineStyles(withClasses, node.inlineStyles, config.mediaAssets)
  return config.annotateNodeIds ? injectNodeId(withStyles, node.id) : withStyles
}

function resolveLoopData(node: PageNode, config: RenderConfig) {
  if (node.props.sourceId !== ENTRY_FIELD_SOURCE_ID) {
    return config.loopData?.get(node.id)
  }

  const filters = node.props.filters
  const fieldId =
    filters && typeof filters === 'object' && !Array.isArray(filters)
      ? (filters as Record<string, unknown>)[ENTRY_FIELD_FILTER_KEY]
      : undefined
  if (typeof fieldId !== 'string' || !fieldId) {
    return { items: [], totalItems: 0, pageNumber: 1, hasMore: false }
  }

  const stack = config.templateContext?.entryStack ?? []
  const entry = stack[stack.length - 1]
  const value = entry?.fields[fieldId]
  const resolved = resolveEntryFieldItems(value, {
    offset: typeof node.props.offset === 'number' ? node.props.offset : 0,
    limit: typeof node.props.limit === 'number' ? node.props.limit : 10,
    direction: node.props.direction === 'desc' ? 'desc' : 'asc',
    mediaByReference: config.mediaAssets as ReadonlyMap<string, EntryFieldMedia> | undefined,
  })
  return {
    ...resolved,
    pageNumber: 1,
    hasMore: false,
  }
}
