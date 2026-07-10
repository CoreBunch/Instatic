import type { PageNode } from './pageNode'

// ---------------------------------------------------------------------------
// cloneNodeWithRemap — the single node deep-clone primitive
// ---------------------------------------------------------------------------

/**
 * Deep-clone a single node, assigning a fresh `id` and remapping its child /
 * class references. This is THE one place that knows the full persisted shape
 * of a node, so adding a new persisted `BaseNode`/`PageNode` field means editing
 * exactly one clone site — `duplicateNode`, `pasteSubtree`, and `duplicatePage`
 * all route through here and keep only their own id-map construction + insertion
 * placement (the genuinely-different part).
 *
 * Every persisted sub-object is copied so NOTHING is shared by reference with
 * the source:
 *   - `props` — shallow-copied (prop values are content, mutated via replace).
 *   - `breakpointOverrides` — deep-copied one level (per-breakpoint bags).
 *   - `inlineStyles` / `propBindings` / `dynamicBindings` — copied when present.
 *   - `children` — remapped through `idMap`; ids absent from the map are dropped
 *     (a self-contained subtree has every child in the map, so for well-formed
 *     trees this is a no-op; dangling ids are corrupt data and pruned).
 *
 * `classIdRemap` is the per-caller class policy: return a new id to remap, the
 * same id to keep, or `null` to drop the class. Omit it to copy classIds as-is.
 * Same-document clones (duplicateNode / duplicatePage) keep unknown classIds
 * (they reference shared site-level classes that still exist); foreign-source
 * paste drops classIds the target document can't resolve.
 */
export function cloneNodeWithRemap(
  node: PageNode,
  options: {
    newId: string
    idMap: ReadonlyMap<string, string>
    classIdRemap?: (classId: string) => string | null
  },
): PageNode {
  const { newId, idMap, classIdRemap } = options

  const cloned: PageNode = {
    ...node,
    id: newId,
    props: { ...node.props },
    breakpointOverrides: Object.fromEntries(
      Object.entries(node.breakpointOverrides).map(([k, v]) => [k, { ...v }]),
    ),
    children: node.children
      .map((childId) => idMap.get(childId))
      .filter((cid): cid is string => typeof cid === 'string'),
    classIds: classIdRemap
      ? node.classIds.flatMap((cid) => {
          const next = classIdRemap(cid)
          return next === null ? [] : [next]
        })
      : [...node.classIds],
  }

  // Deep-copy the remaining optional persisted sub-objects so the clone never
  // shares a mutable object with its source.
  if (node.inlineStyles) cloned.inlineStyles = { ...node.inlineStyles }
  if (node.attributes) cloned.attributes = { ...node.attributes }
  if (node.propBindings) {
    cloned.propBindings = Object.fromEntries(
      Object.entries(node.propBindings).map(([k, v]) => [k, { ...v }]),
    )
  }
  if (node.dynamicBindings) {
    cloned.dynamicBindings = Object.fromEntries(
      Object.entries(node.dynamicBindings).map(([k, v]) => [k, { ...v }]),
    )
  }

  return cloned
}
