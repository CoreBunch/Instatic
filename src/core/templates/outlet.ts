/**
 * base.outlet detection helpers — the single source of truth for the
 * one-outlet-per-document invariant.
 *
 * A document tree holds AT MOST ONE `base.outlet`: the template composer and
 * the canvas's read-only wrapper fill only the first, leaving any extra outlet
 * to render as a dead, empty placeholder. Every layer that needs to ask "does
 * this tree / subtree contain an outlet?" — the composer, the editor's
 * insertion gates, duplicate/paste guards, the module picker — goes through
 * these helpers.
 */
import type { PageNode } from '@core/page-tree'

type Nodes = Record<string, PageNode>

/**
 * The first base.outlet id in a tree, or null when there is none.
 *
 * Deliberately forgiving: a template with NO outlet is an unfinished template
 * (the author's business, not a hard error); a template with MORE THAN ONE
 * outlet uses the first and leaves the rest to render empty. Nothing here
 * throws — an unfinished template never breaks publishing.
 */
export function firstOutletId(nodes: Nodes): string | null {
  for (const id in nodes) if (nodes[id].moduleId === 'base.outlet') return id
  return null
}

/** Whether a document tree contains at least one base.outlet. */
export function treeHasOutlet(tree: { nodes: Nodes }): boolean {
  return firstOutletId(tree.nodes) !== null
}

/**
 * Whether the subtree rooted at `rootId` contains a base.outlet. Used by the
 * duplicate guards: duplicating a section that carries the document's outlet
 * would mint a second one.
 */
export function subtreeHasOutlet(nodes: Nodes, rootId: string): boolean {
  const root = nodes[rootId]
  if (!root) return false
  if (root.moduleId === 'base.outlet') return true
  return root.children.some((childId) => subtreeHasOutlet(nodes, childId))
}
