/**
 * Publisher — editable HTML projection renderers (God Mode).
 *
 * When `RenderConfig.projection` is true, the structural modules render as
 * `instatic-*` marker tags instead of their expanded publish output, so the
 * HTML a God Mode panel shows is an honest, round-trippable projection of
 * the page tree:
 *
 *   base.loop                 → <instatic-loop …>          template once
 *   base.visual-component-ref → <instatic-component …>     internals opaque
 *   base.slot-instance        → <instatic-slot …>          fills editable
 *   base.slot-outlet          → <instatic-slot-outlet …>   default content
 *   base.outlet               → <instatic-outlet …>        childless marker
 *
 * The loop/outlet attribute vocabulary matches `htmlImport/rules.ts`
 * (`mapLoopProps` / `mapOutletProps`) exactly — one dialect for the whole
 * system: what the projection emits is what the importer accepts. The
 * component/slot tags are new to the dialect; the uid-preserving importer
 * (God Mode ticket 03) maps them back to their node kinds.
 *
 * Identity travels via `uid` only — projection implies uid annotation. Locked /
 * hidden / label / binding metadata is never emitted — a matched uid keeps
 * it through the import patch instead. Feature doc: docs/features/god-mode.md.
 */

import type { PageNode } from '@core/page-tree'
import { selectVisualComponentById } from '@core/page-tree'
import { resolveSlotName } from '@core/visualComponents'
import { escapeHtml } from './utils'
import { htmlAttributesAttr } from './htmlAttributesEmit'
import type { RenderConfig, RenderAccumulators, RenderNodeFn } from './renderConfig'

/** The projection dialect's marker tag names, shared with the importer. */
export const PROJECTION_TAGS = {
  loop: 'instatic-loop',
  component: 'instatic-component',
  slot: 'instatic-slot',
  slotOutlet: 'instatic-slot-outlet',
  outlet: 'instatic-outlet',
} as const

export type ProjectionTag = (typeof PROJECTION_TAGS)[keyof typeof PROJECTION_TAGS]

/**
 * The attributes each marker tag carries — the dialect's vocabulary in one
 * place, matching what the renderers below emit and `htmlImport` reads
 * (`instaticDialect.ts`, `rules.ts`). The God Mode editor completes from it.
 */
export const PROJECTION_TAG_ATTRIBUTES: Readonly<Record<ProjectionTag, readonly string[]>> = {
  [PROJECTION_TAGS.loop]: [
    'data-source-id',
    'data-table-id',
    'data-order-by',
    'data-direction',
    'data-limit',
    'data-offset',
    'data-pagination',
    'data-page-size',
    'data-tag',
    'data-custom-tag',
  ],
  [PROJECTION_TAGS.component]: ['data-component-id', 'data-component-name'],
  [PROJECTION_TAGS.slot]: ['data-slot-name'],
  [PROJECTION_TAGS.slotOutlet]: ['data-slot-name'],
  [PROJECTION_TAGS.outlet]: ['data-tag', 'data-custom-tag'],
}

export function isProjectionTag(tagName: string): tagName is ProjectionTag {
  return tagName in PROJECTION_TAG_ATTRIBUTES
}

type ProjectionRenderer = (
  node: PageNode,
  config: RenderConfig,
  acc: RenderAccumulators,
  renderNode: RenderNodeFn,
) => string

function uidAttr(node: PageNode, config: RenderConfig): string {
  // Projection implies uid annotation — without uids the dialect loses its
  // identity guarantee (see RenderConfig.projection). annotateNodeIds still
  // works standalone for the agent read surface.
  return config.annotateNodeIds || config.projection
    ? ` uid="${escapeHtml(node.id)}"`
    : ''
}

function attrIf(name: string, value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return ` ${name}="${value}"`
  if (typeof value === 'string' && value !== '') return ` ${name}="${escapeHtml(value)}"`
  return ''
}

/** data-tag / data-custom-tag pair, mirroring `mapOutletProps`/`mapLoopProps`. */
function tagAttrs(props: Record<string, unknown>): string {
  if (props.tag === 'custom') return attrIf('data-custom-tag', props.customTag)
  return props.tag === undefined ? '' : attrIf('data-tag', props.tag)
}

function renderChildren(
  node: PageNode,
  config: RenderConfig,
  acc: RenderAccumulators,
  renderNode: RenderNodeFn,
): string {
  return (node.children ?? []).map((childId) => renderNode(childId, config, acc)).join('')
}

/**
 * `base.loop` — the marker tag carries the loop's source configuration in
 * the import dialect's attributes, and the children (the round-robin
 * variants) render exactly once each as the item template, tokens intact.
 * Resolved loop data is deliberately ignored: iterations are publish
 * output, not source.
 */
const renderProjectionLoop: ProjectionRenderer = (node, config, acc, renderNode) => {
  const props = node.props
  const filters = props.filters
  const tableId =
    filters && typeof filters === 'object' && !Array.isArray(filters)
      ? (filters as Record<string, unknown>).tableId
      : undefined

  let attrs = uidAttr(node, config)
  attrs += attrIf('data-source-id', props.sourceId)
  attrs += attrIf('data-table-id', tableId)
  attrs += attrIf('data-order-by', props.orderBy)
  attrs += attrIf('data-direction', props.direction)
  attrs += attrIf('data-limit', props.limit)
  attrs += attrIf('data-offset', props.offset)
  if (props.pagination === 'infinite') {
    attrs += ` data-pagination="infinite"`
    attrs += attrIf('data-page-size', props.pageSize)
  }
  attrs += tagAttrs(props)
  // Author attributes survive verbatim (tokens included) — same sanitiser the
  // publish renderer uses, so data-instatic-* stays reserved.
  attrs += htmlAttributesAttr(props.htmlAttributes)

  const template = renderChildren(node, config, acc, renderNode)
  return `<${PROJECTION_TAGS.loop}${attrs}>${template}</${PROJECTION_TAGS.loop}>`
}

/**
 * `base.visual-component-ref` — opaque: the VC definition tree is NOT
 * expanded. The children rendered inside are the ref's `base.slot-instance`
 * nodes (user-authored slot fills), which stay editable.
 */
const renderProjectionComponentRef: ProjectionRenderer = (node, config, acc, renderNode) => {
  const componentId =
    typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
  const vc = componentId ? selectVisualComponentById(config.site, componentId) : undefined

  let attrs = uidAttr(node, config)
  attrs += attrIf('data-component-id', componentId)
  attrs += attrIf('data-component-name', vc?.name)

  const fills = renderChildren(node, config, acc, renderNode)
  return `<${PROJECTION_TAGS.component}${attrs}>${fills}</${PROJECTION_TAGS.component}>`
}

/** `base.slot-instance` — named fill wrapper; children are user content. */
const renderProjectionSlotInstance: ProjectionRenderer = (node, config, acc, renderNode) => {
  const attrs = uidAttr(node, config) + attrIf('data-slot-name', resolveSlotName(node.props))
  const content = renderChildren(node, config, acc, renderNode)
  return `<${PROJECTION_TAGS.slot}${attrs}>${content}</${PROJECTION_TAGS.slot}>`
}

/** `base.slot-outlet` — VC-definition slot marker; children are default content. */
const renderProjectionSlotOutlet: ProjectionRenderer = (node, config, acc, renderNode) => {
  const attrs = uidAttr(node, config) + attrIf('data-slot-name', resolveSlotName(node.props))
  const content = renderChildren(node, config, acc, renderNode)
  return `<${PROJECTION_TAGS.slotOutlet}${attrs}>${content}</${PROJECTION_TAGS.slotOutlet}>`
}

/**
 * `base.outlet` — the template content outlet. Childless in the import
 * dialect (the composer fills it at publish time), so no children render.
 */
const renderProjectionOutlet: ProjectionRenderer = (node, config) => {
  const attrs =
    uidAttr(node, config) +
    tagAttrs(node.props) +
    htmlAttributesAttr(node.props.htmlAttributes)
  return `<${PROJECTION_TAGS.outlet}${attrs}></${PROJECTION_TAGS.outlet}>`
}

const PROJECTION_RENDERER_IMPLS: ReadonlyMap<string, ProjectionRenderer> = new Map([
  ['base.loop', renderProjectionLoop],
  ['base.visual-component-ref', renderProjectionComponentRef],
  ['base.slot-instance', renderProjectionSlotInstance],
  ['base.slot-outlet', renderProjectionSlotOutlet],
  ['base.outlet', renderProjectionOutlet],
])

/**
 * Resolve the projection renderer for a module id, or undefined when the
 * node renders through the standard path (with the projection tweaks in
 * `renderStandardNode`: tokens verbatim, no media enrichment).
 */
export function resolveProjectionRenderer(
  moduleId: string,
): ProjectionRenderer | undefined {
  return PROJECTION_RENDERER_IMPLS.get(moduleId)
}
