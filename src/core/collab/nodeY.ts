/**
 * Plain node ⇄ node Y.Map conversion — the one place that knows how a
 * `BaseNode`/`PageNode` maps onto Y types. Used by seeding (whole trees),
 * the patch translator (node creation), and the projection (reading back).
 *
 * Structured fields get collaborative Y types; every OTHER node field is a
 * plain LWW value set by key — new node fields flow through automatically:
 *   props                → Y.Map; the module's inline-text prop → Y.Text
 *   breakpointOverrides  → Y.Map<bp, Y.Map<key, plain>>
 *   children             → Y.Array<string>
 *   parentId             → NEVER stored (derived cache; projection reindexes)
 */
import * as Y from 'yjs'
import type { BaseNode } from '@core/page-tree'
import { inlineTextPropOf } from './schema'

const STRUCTURED_KEYS = new Set(['props', 'breakpointOverrides', 'children', 'parentId'])

/**
 * Take ownership of a value read out of a Y container.
 *
 * Yjs stores plain JS values BY REFERENCE — `Y.Map.get()` hands back the very
 * object living inside the CRDT. Projecting those references out would make
 * the editor store and the doc share mutable state, which breaks in both
 * directions:
 *
 *   - Consumers that normalize in place would rewrite CRDT state outside any
 *     transaction. `validateSite` does exactly this (`normalizeFrameworkColors`
 *     assigns `colors.tokens`), so merely projecting a shell used to rewrite
 *     the colour tokens held in the doc — a silent, untracked mutation that
 *     never reaches a peer.
 *   - The editor store runs Mutative with `enableAutoFreeze: true`, so the
 *     moment a projection lands in the store, everything reachable from it is
 *     deep-frozen — including the objects the doc still holds. The NEXT
 *     projection then throws `TypeError: Cannot assign to read only property`,
 *     the projection is skipped, and the canvas never updates again.
 *
 * Primitives — the overwhelming majority of node props — pass straight
 * through. Y types are returned untouched: they only reach here from a
 * malformed doc, and `structuredClone` would throw on their internals.
 */
export function own<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Y.AbstractType) return value
  return structuredClone(value) as T
}

export function buildPropsMap(
  moduleId: string,
  props: Record<string, unknown>,
): Y.Map<unknown> {
  const inlineProp = inlineTextPropOf(moduleId)
  const map = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(props)) {
    if (key === inlineProp && typeof value === 'string') {
      map.set(key, new Y.Text(value))
    } else {
      map.set(key, value)
    }
  }
  return map
}

export function buildBreakpointOverridesMap(
  overrides: Record<string, Record<string, unknown>>,
): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  for (const [bpId, bag] of Object.entries(overrides)) {
    const bpMap = new Y.Map<unknown>()
    for (const [key, value] of Object.entries(bag)) bpMap.set(key, value)
    map.set(bpId, bpMap)
  }
  return map
}

export function buildNodeMap(node: BaseNode): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  map.set('props', buildPropsMap(node.moduleId, node.props))
  map.set('breakpointOverrides', buildBreakpointOverridesMap(node.breakpointOverrides))
  const children = new Y.Array<string>()
  children.push([...node.children])
  map.set('children', children)
  for (const [key, value] of Object.entries(node)) {
    if (STRUCTURED_KEYS.has(key)) continue
    if (value === undefined) continue
    map.set(key, value)
  }
  return map
}

/** Read a node Y.Map back to a plain node (without `parentId` — reindexed later). */
export function projectNodeMap(nodeMap: Y.Map<unknown>): BaseNode {
  const out: Record<string, unknown> = {}
  for (const [key, value] of nodeMap.entries()) {
    if (key === 'props') {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of (value as Y.Map<unknown>).entries()) {
        props[pk] = pv instanceof Y.Text ? pv.toString() : own(pv)
      }
      out.props = props
    } else if (key === 'breakpointOverrides') {
      const overrides: Record<string, Record<string, unknown>> = {}
      for (const [bp, bag] of (value as Y.Map<unknown>).entries()) {
        const entries: Record<string, unknown> = {}
        for (const [ok, ov] of (bag as Y.Map<unknown>).entries()) entries[ok] = own(ov)
        overrides[bp] = entries
      }
      out.breakpointOverrides = overrides
    } else if (key === 'children') {
      out.children = (value as Y.Array<string>).toArray()
    } else {
      out[key] = own(value)
    }
  }
  // Structured fields always exist on a well-formed node; default defensively
  // for docs damaged by partial concurrent construction.
  out.props ??= {}
  out.breakpointOverrides ??= {}
  out.children ??= []
  return out as unknown as BaseNode
}
