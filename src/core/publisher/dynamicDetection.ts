/**
 * Dynamic-node detection — the single source of truth for "which nodes in
 * a page tree must be deferred to request time."
 *
 * `findDynamicNodeIds(page, site, registry)` classifies every node in a
 * page tree as either static (can be pre-rendered at publish time) or
 * dynamic (must be deferred to request time via a `<instatic-hole>` placeholder).
 * It returns the SET of node IDs that are dynamic; an empty set means the
 * page is fully static.
 *
 * `findDynamicNodesWithReasons(...)` returns the same set PLUS a list of
 * human-readable reason strings for diagnostics.
 *
 * The four detection rules (per spec, "Auto-detection rules"):
 *
 *   1. Module is flagged `dynamic: true` in the registry.
 *   2. Node has a `dynamicBindings` entry whose source is request-dependent
 *      (currently: `route.query.*`).
 *   2b. A string prop value contains a `{source.field}` token whose source is
 *      request-dependent.
 *   3. `moduleId === 'base.loop'` AND the loop source has `requestDependent: true`
 *      or `perVisitor: true`.
 *   4. `moduleId === 'base.visual-component-ref'` whose VC definition tree
 *      contains any dynamic node (recursive check with cycle guard).
 *
 * VC ref subtlety: when the VC definition tree is dynamic, the OUTER VC ref
 * node id (in the page tree) goes into `dynamicPageNodeIds` — not the inner
 * VC node ids. The hole boundary is the VC ref, not any inner node. Diagnostic
 * reasons collected from inner VC traversal are still appended to the reason
 * list so authors can see WHICH inner construct made the VC dynamic.
 *
 * Layer A's shell-vs-complete decision and Layer C's `renderNode` placeholder
 * emission both consume the id set; diagnostics consume the reason list.
 * Keeping both behind one walker means the rules cannot drift between layers.
 */

import type { Page, SiteDocument, DynamicPropBinding } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import { selectVisualComponentById } from '@core/page-tree'
import { loopSourceRegistry } from '@core/loops/registry'
import { containsTokens, parseTokenString } from '@core/templates/tokenInterpolation'

// ---------------------------------------------------------------------------
// Binding-source classification
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the given binding source + field resolves at request time
 * rather than at publish time.
 *
 * Single extensibility point for "what counts as request-dependent." Accepts
 * `string` (not the strict `DynamicBindingSource` union) so plugin-registered
 * sources can extend the classification without changing the union type.
 *
 * Built-in classification:
 *   - `route.query.*`     → request-time (varies with URL query string)
 *   - `currentEntry.*`    → publish-time (entry is known at publish)
 *   - `parentEntry.*`     → publish-time
 *   - `page.*`            → publish-time
 *   - `site.*`            → publish-time
 *   - `route.path`        → publish-time (fixed per static route)
 *   - `route.slug`        → publish-time
 */
function isBindingSourceRequestDependent(source: string, field: string): boolean {
  switch (source) {
    case 'route':
      // route.path and route.slug are fixed per static route.
      // route.query and route.query.* vary per visitor URL.
      return field === 'query' || field.startsWith('query.')
    case 'currentEntry':
    case 'parentEntry':
    case 'page':
    case 'site':
      return false
    default:
      // Unknown source — conservatively treated as publish-time deterministic
      // to avoid false positives forcing unnecessary dynamic rendering.
      // Plugin authors adding request-dependent sources should update this
      // function or register sources via a future plugin-source registry.
      return false
  }
}

// ---------------------------------------------------------------------------
// Internal node type
// ---------------------------------------------------------------------------

/**
 * Structural minimum shared by PageNode and VCNode, sufficient for
 * dynamic-classification logic.
 */
interface AnalysisNode {
  id: string
  moduleId: string
  props: Record<string, unknown>
  children: string[]
  dynamicBindings?: Record<string, DynamicPropBinding>
}

// ---------------------------------------------------------------------------
// Per-node rule checks (return reason strings, null if static)
// ---------------------------------------------------------------------------

/**
 * Rule 2: structured dynamicBindings whose source is request-dependent.
 * Returns the first matching reason string or null.
 */
function checkDynamicBindings(node: AnalysisNode): string | null {
  if (!node.dynamicBindings) return null
  for (const [propKey, binding] of Object.entries(node.dynamicBindings)) {
    if (isBindingSourceRequestDependent(binding.source, binding.field)) {
      return `node "${node.id}": binding "${propKey}" source "${binding.source}.${binding.field}" is request-dependent`
    }
  }
  return null
}

/**
 * Rule 2b: {source.field} tokens embedded in string prop values.
 * Returns the first matching reason string or null.
 */
function checkInlineTokens(node: AnalysisNode): string | null {
  for (const [propKey, propValue] of Object.entries(node.props)) {
    if (typeof propValue !== 'string') continue
    if (!containsTokens(propValue)) continue
    const segments = parseTokenString(propValue)
    for (const seg of segments) {
      if (seg.kind !== 'token') continue
      if (isBindingSourceRequestDependent(seg.source, seg.field)) {
        return `node "${node.id}": prop "${propKey}" contains request-dependent token "{${seg.source}.${seg.field}}"`
      }
    }
  }
  return null
}

/**
 * Rule 3: `base.loop` whose source is request-dependent or per-visitor.
 * Returns reason or null. An unregistered/empty sourceId stays static.
 * `perVisitor` implies request-dependent (it also renders at request time —
 * just uncached); both route the loop node to a Layer C hole.
 */
function checkLoopSource(node: AnalysisNode): string | null {
  if (node.moduleId !== 'base.loop') return null
  const sourceId = typeof node.props.sourceId === 'string' ? node.props.sourceId : ''
  if (!sourceId) return null
  const loopSource = loopSourceRegistry.get(sourceId)
  if (loopSource?.requestDependent === true || loopSource?.perVisitor === true) {
    const reason = loopSource?.perVisitor === true ? 'per-visitor' : 'request-dependent'
    return `node "${node.id}": loop source "${sourceId}" is ${reason}`
  }
  return null
}

// ---------------------------------------------------------------------------
// The single rule definition
// ---------------------------------------------------------------------------

/**
 * The single source of truth for "is this ONE node request-dependent?". Applies
 * Rules 1–4 in order and returns the first match:
 *
 *   1. module flagged `dynamic: true`
 *   2. structured `dynamicBindings` with a request-dependent source
 *   2b. inline `{source.field}` request-dependent token in a string prop
 *   3. `base.loop` with a request-dependent / per-visitor source
 *   4. `base.visual-component-ref` whose VC definition tree contains any
 *      request-dependent node (recursive, cycle-guarded via `seenVcs`)
 *
 * `seenVcs` carries the VC component-ids already on the DFS stack so VC → VC
 * cycles terminate; a cycle is treated as dynamic (defensive — and consistent
 * everywhere this predicate is used).
 *
 * Returns `dynamic` plus the first human-readable `reason` (null when static).
 * For a dynamic VC ref the reason names the inner construct that made the VC
 * dynamic, so diagnostics point at the real cause.
 *
 * Both the main classification pass AND the static-loop-body pre-pass (Rule 3.5)
 * route every per-node decision through this function — there is exactly one
 * rule definition, so a future rule is one edit here and both passes honour it.
 */
function classifyNode(
  node: AnalysisNode,
  site: SiteDocument,
  registry: IModuleRegistry,
  seenVcs: ReadonlySet<string>,
): { dynamic: boolean; reason: string | null } {
  // Rule 1: module flagged dynamic.
  const def = registry.get(node.moduleId)
  if (def?.dynamic) {
    return { dynamic: true, reason: `node "${node.id}" (${node.moduleId}): module is flagged dynamic` }
  }

  // Rule 2: structured dynamicBindings.
  const bindingReason = checkDynamicBindings(node)
  if (bindingReason) return { dynamic: true, reason: bindingReason }

  // Rule 2b: inline {source.field} tokens.
  const tokenReason = checkInlineTokens(node)
  if (tokenReason) return { dynamic: true, reason: tokenReason }

  // Rule 3: base.loop with a request-dependent source.
  const loopReason = checkLoopSource(node)
  if (loopReason) return { dynamic: true, reason: loopReason }

  // Rule 4: base.visual-component-ref → the ref is dynamic iff its VC
  // definition tree contains any request-dependent node.
  if (node.moduleId === 'base.visual-component-ref') {
    const componentId =
      typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
    if (!componentId) return { dynamic: false, reason: null }

    if (seenVcs.has(componentId)) {
      // Cycle — terminate and treat as dynamic. The hole boundary is the OUTER
      // ref node (this node), never a node inside the cyclic VC tree.
      return {
        dynamic: true,
        reason: `node "${node.id}": cycle detected in VC ref chain (VC "${componentId}" is already being analysed)`,
      }
    }

    const vc = selectVisualComponentById(site, componentId)
    if (!vc) return { dynamic: false, reason: null } // Unknown VC → static, matches render behaviour

    const innerReasons = collectSubtreeReasons(
      [vc.tree.rootNodeId],
      vc.tree.nodes as Record<string, AnalysisNode>,
      site,
      registry,
      new Set(seenVcs).add(componentId),
    )
    if (innerReasons.length > 0) {
      // Surface the first inner reason so diagnostics name the construct that
      // made the VC dynamic.
      return { dynamic: true, reason: innerReasons[0] }
    }
    return { dynamic: false, reason: null }
  }

  return { dynamic: false, reason: null }
}

/**
 * DFS the subtree rooted at each id in `rootIds` (descending through `children`
 * within `nodes`), classifying every visited node via {@link classifyNode}.
 * Returns the reasons of all request-dependent nodes found, in DFS order; when
 * `visitedIds` is provided, every visited node id is recorded into it.
 *
 * This is the shared traversal behind Rule 4's VC-tree scan and the
 * static-loop-body pre-pass (Rule 3.5). Both ask "does this subtree contain a
 * request-dependent node?" through the SAME {@link classifyNode} definition —
 * `classifyNode` handles descent into VC definition trees, while this walker
 * handles descent through page-tree children, so VC refs in a loop body promote
 * the loop whether the dynamism comes from the VC tree or from slot-fill
 * children.
 */
function collectSubtreeReasons(
  rootIds: readonly string[],
  nodes: Record<string, AnalysisNode>,
  site: SiteDocument,
  registry: IModuleRegistry,
  seenVcs: ReadonlySet<string>,
  visitedIds?: Set<string>,
): string[] {
  const reasons: string[] = []
  const visit = (nodeId: string): void => {
    const node = nodes[nodeId]
    if (!node) return
    visitedIds?.add(node.id)
    const { reason } = classifyNode(node, site, registry, seenVcs)
    if (reason) reasons.push(reason)
    // Keep descending even after a hit so `visitedIds` captures the FULL body
    // for suppression (ISS-021), not just the prefix up to the first dynamic
    // node.
    for (const childId of node.children) visit(childId)
  }
  for (const rootId of rootIds) visit(rootId)
  return reasons
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface WalkResult {
  dynamicPageNodeIds: Set<string>
  reasons: string[]
}

/**
 * Single pass over `page.nodes` that returns BOTH the set of page-level node
 * ids needing `<instatic-hole>` placeholders AND the human-readable reason
 * strings. Layer A's shell-vs-complete decision and Layer C's `renderNode`
 * placeholder emission both derive from this one walker — and every per-node
 * decision runs through {@link classifyNode}, so the rules cannot drift between
 * the pre-pass and the main pass, or between layers.
 */
function findDynamicNodesWithReasons(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
): WalkResult {
  const nodes = page.nodes as Record<string, AnalysisNode>
  const result: WalkResult = { dynamicPageNodeIds: new Set(), reasons: [] }
  const rootVcStack: ReadonlySet<string> = new Set()

  // Pre-pass (Rule 3.5): a static base.loop whose body contains a
  // request-dependent node is promoted to a single hole, and its body
  // descendant ids are suppressed so the main pass doesn't emit a separate hole
  // per iteration (ISS-021). Loops with a dynamic source are handled by Rule 3
  // in the main pass.
  const suppressed = new Set<string>()
  const promotedLoops = new Set<string>()
  for (const node of Object.values(nodes)) {
    if (node.moduleId !== 'base.loop' || checkLoopSource(node)) continue
    const bodyIds = new Set<string>()
    const bodyReasons = collectSubtreeReasons(node.children, nodes, site, registry, rootVcStack, bodyIds)
    if (bodyReasons.length > 0) {
      promotedLoops.add(node.id)
      for (const id of bodyIds) suppressed.add(id)
    }
  }

  // Main pass: classify every page node through the one shared predicate.
  for (const node of Object.values(nodes)) {
    // Covered by an enclosing promoted loop hole — never a hole on its own.
    if (suppressed.has(node.id)) continue

    if (promotedLoops.has(node.id)) {
      result.dynamicPageNodeIds.add(node.id)
      result.reasons.push(`node "${node.id}": static loop body contains a request-dependent node`)
      continue
    }

    const { reason } = classifyNode(node, site, registry, rootVcStack)
    if (reason) {
      result.dynamicPageNodeIds.add(node.id)
      result.reasons.push(reason)
    }
  }

  return result
}

/**
 * Returns the set of PAGE node ids whose subtree must be deferred to a
 * `<instatic-hole>` placeholder. Empty set means the page is fully static.
 *
 * Public wrapper for callers that only need the ids. The shared walker also
 * keeps reason strings internally so diagnostics can reuse the same rule path.
 */
export function findDynamicNodeIds(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
): Set<string> {
  return findDynamicNodesWithReasons(page, site, registry).dynamicPageNodeIds
}
