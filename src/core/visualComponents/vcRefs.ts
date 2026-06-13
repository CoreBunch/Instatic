/**
 * vcRefs — the single source of truth for "what is a VC reference node".
 *
 * A Visual Component is embedded by a `base.visual-component-ref` node whose
 * `props.componentId` names the target VC. That predicate was previously
 * re-encoded in three places (the recursion guard's reachability scan and both
 * of the deletion-impact preview loops). It lives here once.
 *
 * Accepts `unknown` node maps so it can run on raw/untyped data (validateSite,
 * recursion guarding) and on fully-typed page / VC trees alike.
 *
 * Constraint #269: This file must NOT import from editor/ or editor-store/.
 */

const VC_REF_MODULE_ID = 'base.visual-component-ref'

/** A discovered VC reference: the host node's id and the VC it embeds. */
interface VCRef {
  nodeId: string
  componentId: string
}

/**
 * Invoke `cb` once for every `base.visual-component-ref` node in a flat node
 * map, passing the node's id and the referenced `componentId`.
 *
 * `nodes` is typed `unknown` on purpose — callers range from raw persisted data
 * to typed `Page.nodes` / `VisualComponent.tree.nodes`. Non-object maps, non-ref
 * nodes, and refs with a missing/blank `componentId` are skipped.
 */
export function forEachVCRef(nodes: unknown, cb: (ref: VCRef) => void): void {
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return

  for (const node of Object.values(nodes as Record<string, unknown>)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue
    const n = node as Record<string, unknown>
    if (n.moduleId !== VC_REF_MODULE_ID) continue

    const props = n.props
    if (!props || typeof props !== 'object' || Array.isArray(props)) continue

    const componentId = (props as Record<string, unknown>).componentId
    if (typeof componentId !== 'string' || componentId.length === 0) continue

    cb({ nodeId: typeof n.id === 'string' ? n.id : '', componentId })
  }
}

/** Collect every VC reference in a flat node map. */
export function collectVCRefs(nodes: unknown): VCRef[] {
  const out: VCRef[] = []
  forEachVCRef(nodes, (ref) => out.push(ref))
  return out
}
