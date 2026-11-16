/**
 * The show-when rules that enclose a node: its ancestors', and optionally its
 * own.
 *
 * Rendering a page top-down applies each rule as the walk reaches it. An
 * endpoint that renders ONE node on request (a hole, more items of a loop)
 * starts in the middle of the tree, so it must check the rules above its
 * starting point itself. Otherwise a child of an element limited to members
 * could be fetched directly by anyone who knows its id.
 */
import { readShowWhen, type ShowWhen } from '@core/members'
import type { Page } from '@core/page-tree'

export function enclosingShowWhenRules(
  page: Page,
  nodeId: string,
  options: { includeSelf: boolean },
): Array<ShowWhen | 'nobody'> {
  // Parents are derived from the children lists, the tree's source of truth.
  const parentOf = new Map<string, string>()
  for (const node of Object.values(page.nodes)) {
    for (const childId of node.children) parentOf.set(childId, node.id)
  }

  const rules: Array<ShowWhen | 'nobody'> = []
  const seen = new Set<string>()
  let currentId: string | undefined = options.includeSelf ? nodeId : parentOf.get(nodeId)
  while (currentId !== undefined && !seen.has(currentId)) {
    seen.add(currentId)
    const node = page.nodes[currentId]
    if (!node) break
    const rule = readShowWhen(node.props)
    if (rule !== null) rules.push(rule)
    currentId = parentOf.get(currentId)
  }
  return rules
}
