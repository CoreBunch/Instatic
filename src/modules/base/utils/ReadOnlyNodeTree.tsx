/**
 * ReadOnlyNodeTree — render a flat node map as a NON-interactive React subtree.
 *
 * One renderer for every "show this tree inside the canvas, but don't let the
 * user edit it" case:
 *   - a Visual Component body inlined at a `base.visual-component-ref` (see
 *     `VCInlineTree`, which is a thin wrapper over this);
 *   - the matched content a template's `base.outlet` previews (the first
 *     non-template page, the current entry body);
 *   - (Phase 2) the wrapping template chrome around the document being edited.
 *
 * Nodes render through the module registry — the SAME components the editable
 * canvas uses — so user CSS classes and module styling look identical to the
 * editable surface. There are NO Zustand subscriptions and NO selection / hover
 * / DnD handlers: inner nodes are not independently selectable. The optional
 * `rootNodeWrapperProps` is forwarded onto the FIRST rendered element only, so
 * the owning editor node (the VC ref, the outlet) keeps its single selection
 * overlay.
 *
 * `base.body` is transparent: it emits no wrapper element (matching the
 * publisher), rendering its children directly and forwarding the root class /
 * wrapper bag to the first renderable child.
 *
 * Class resolution mirrors the publisher: each node's `classIds` resolve
 * against the site class registry and pass to the module as `mcClassName`.
 * Per-node `inlineStyles` are applied through the same sanitisation gate the
 * publisher uses (`bagToReactStyle`), so composed content carries the same
 * `style="…"` the published page does.
 */

import type { ReactNode } from 'react'
import { registry } from '@core/module-engine'
import type { NodeWrapperProps as NodeWrapperPropsType } from '@core/module-engine'
import type { BaseNode } from '@core/page-tree'
import { classNamesForClassIds, type StyleRuleRegistry } from '@core/page-tree'
import { bagToReactStyle } from '@core/publisher'

/**
 * Identifies the editable source a read-only region was composed from, so the
 * canvas can label it ("part of X") and open it on double-click. Stamped as
 * `data-instatic-readonly-*` markers on every element of the region.
 */
export interface ReadOnlyRegion {
  /** Human label, e.g. "Global Layout template" or "Hero component". */
  label: string
  /** Routes the open action: 'page' → openPageInCanvas, 'component' → VC document. */
  kind: 'page' | 'component'
  /** The page id or VC id to open. */
  targetId: string
}

interface ReadOnlyNodeTreeProps {
  /** Flat node map — any `NodeTree<BaseNode>` node map (page, VC, composed). */
  nodes: Record<string, BaseNode>
  /** ID of the root node — entry point for traversal. */
  rootNodeId: string
  /** Site class registry — resolves each node's classIds → class names. */
  classes: StyleRuleRegistry
  /** Class string merged onto the first rendered root element. */
  rootMcClassName?: string
  /**
   * Editor wrapper bag (data-node-id, handlers) for the OWNING editor node —
   * forwarded onto the first rendered element so canvas selection targets that
   * single node rather than anything inside the read-only tree.
   */
  rootNodeWrapperProps?: NodeWrapperPropsType
  /**
   * Content to render in place of this tree's FIRST `base.outlet`, replacing
   * the outlet node entirely — exactly mirroring the publisher's
   * `spliceIntoOutlet`. Used when this read-only tree is a wrapping template
   * whose outlet hosts the editable document being edited. When omitted, an
   * outlet renders through its normal (read-only) module component.
   */
  outletSlot?: ReactNode
  /**
   * When set, every element rendered by this tree is stamped with
   * `data-instatic-readonly-*` markers identifying its editable source, so the
   * canvas can show a hover hint and open the source on double-click.
   */
  readonly?: ReadOnlyRegion
}

/** Build the `data-instatic-readonly-*` marker bag spread onto read-only nodes. */
function readonlyMarkers(region: ReadOnlyRegion | undefined): NodeWrapperPropsType | undefined {
  if (!region) return undefined
  return {
    'data-instatic-readonly-label': region.label,
    'data-instatic-readonly-kind': region.kind,
    'data-instatic-readonly-id': region.targetId,
  }
}

/** The first `base.outlet` id in a node map, or undefined when there is none. */
function firstOutletId(nodes: Record<string, BaseNode>): string | undefined {
  for (const id in nodes) {
    if (nodes[id].moduleId === 'base.outlet') return id
  }
  return undefined
}

export function ReadOnlyNodeTree({
  nodes,
  rootNodeId,
  classes,
  rootMcClassName,
  rootNodeWrapperProps,
  outletSlot,
  readonly,
}: ReadOnlyNodeTreeProps) {
  // Resolve the single outlet that hosts `outletSlot` up front so only the
  // first outlet is filled (matching the composer's "first outlet wins").
  const outletNodeId = outletSlot !== undefined ? firstOutletId(nodes) : undefined
  return (
    <ReadOnlyNodeRenderer
      nodeId={rootNodeId}
      nodes={nodes}
      classes={classes}
      extraClassName={rootMcClassName}
      extraNodeWrapperProps={rootNodeWrapperProps}
      outletNodeId={outletNodeId}
      outletSlot={outletSlot}
      readonlyMarkers={readonlyMarkers(readonly)}
    />
  )
}

// ---------------------------------------------------------------------------
// ReadOnlyNodeRenderer — recursive node renderer (no NodeWrapper, not selectable)
// ---------------------------------------------------------------------------

interface ReadOnlyNodeRendererProps {
  nodeId: string
  nodes: Record<string, BaseNode>
  classes: StyleRuleRegistry
  /** Extra class string merged onto this node's mcClassName (first root only). */
  extraClassName?: string
  /** Editor wrapper bag forwarded onto the first rendered root only. */
  extraNodeWrapperProps?: NodeWrapperPropsType
  /** The outlet node id that should render `outletSlot` instead of itself. */
  outletNodeId?: string
  /** Content rendered in place of the outlet node identified by `outletNodeId`. */
  outletSlot?: ReactNode
  /** Read-only marker bag stamped on every node lacking selection props. */
  readonlyMarkers?: NodeWrapperPropsType
}

function ReadOnlyNodeRenderer({
  nodeId,
  nodes,
  classes,
  extraClassName,
  extraNodeWrapperProps,
  outletNodeId,
  outletSlot,
  readonlyMarkers,
}: ReadOnlyNodeRendererProps) {
  const node = nodes[nodeId]
  if (!node) return null
  if (node.hidden) return null

  // Splice the editable document into the wrapping template's outlet: the
  // outlet node is replaced wholesale by `outletSlot`, just as the publisher
  // deletes the outlet and inserts the matched content at its position.
  if (nodeId === outletNodeId) {
    return <>{outletSlot}</>
  }

  if (node.moduleId === 'base.body') {
    const firstRenderableChildId = node.children.find((childId) => isRenderableNode(nodes, childId))
    return (
      <>
        {node.children.map((childId) => (
          <ReadOnlyNodeRenderer
            key={childId}
            nodeId={childId}
            nodes={nodes}
            classes={classes}
            extraClassName={childId === firstRenderableChildId ? extraClassName : undefined}
            extraNodeWrapperProps={childId === firstRenderableChildId ? extraNodeWrapperProps : undefined}
            outletNodeId={outletNodeId}
            outletSlot={outletSlot}
            readonlyMarkers={readonlyMarkers}
          />
        ))}
      </>
    )
  }

  const definition = registry.get(node.moduleId)
  if (!definition) return null

  const ComponentType = definition.component

  const children = node.children.map((childId) => (
    <ReadOnlyNodeRenderer
      key={childId}
      nodeId={childId}
      nodes={nodes}
      classes={classes}
      outletNodeId={outletNodeId}
      outletSlot={outletSlot}
      readonlyMarkers={readonlyMarkers}
    />
  ))

  const ownClassNames = classNamesForClassIds(classes, node.classIds)
  const merged = [extraClassName, ...ownClassNames].filter(Boolean).join(' ')
  const mcClassName = merged.length > 0 ? merged : ''

  // Selection-forwarding nodes (the VC ref root) keep their editor bag; every
  // other read-only node carries only the read-only markers so the canvas can
  // identify and label the region.
  const baseWrapperProps = extraNodeWrapperProps ?? readonlyMarkers

  // Apply the node's inline styles, exactly as the publisher's
  // `injectNodeInlineStyles` emits them as a `style="…"` attribute — composed
  // content (template chrome, outlet previews, VC bodies) must not lose them.
  // A forwarded root bag's style is appended AFTER the node's own declarations
  // (so the owning node wins per property), mirroring the publisher's
  // append-order in `renderVisualComponentRef`.
  const ownStyle = bagToReactStyle(node.inlineStyles)
  const style = ownStyle || baseWrapperProps?.style
    ? { ...ownStyle, ...baseWrapperProps?.style }
    : undefined
  const nodeWrapperProps = style ? { ...baseWrapperProps, style } : baseWrapperProps

  return (
    <ComponentType
      props={node.props as never}
      nodeId={node.id}
      isSelected={false}
      mcClassName={mcClassName}
      nodeWrapperProps={nodeWrapperProps}
    >
      {children}
    </ComponentType>
  )
}

function isRenderableNode(nodes: Record<string, BaseNode>, nodeId: string): boolean {
  const node = nodes[nodeId]
  if (!node || node.hidden) return false
  if (node.moduleId === 'base.body') {
    return node.children.some((childId) => isRenderableNode(nodes, childId))
  }
  return Boolean(registry.get(node.moduleId))
}
