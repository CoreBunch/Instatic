/**
 * Framework class usage — which framework-generated utility classes are
 * actually assigned to nodes anywhere in the site.
 *
 * Reconcile keys every framework-generated class under the `framework:` id
 * prefix. This collector is shared by the publisher's tree-shake (drop unused
 * classes from published CSS) and the editor's "remove unused framework
 * classes" action (prune the tokens/generators that produce only-unused
 * classes).
 */
import type { SiteDocument } from '@core/page-tree'

const FRAMEWORK_ID_PREFIX = 'framework:'

function addFrameworkClassIds(target: Set<string>, classIds: string[] | undefined): void {
  if (!classIds) return
  for (const id of classIds) {
    if (id.startsWith(FRAMEWORK_ID_PREFIX)) target.add(id)
  }
}

/** Every framework-generated class id assigned to a node (pages + Visual Components). */
export function collectUsedFrameworkClassIds(site: SiteDocument): Set<string> {
  const used = new Set<string>()
  for (const page of site.pages) {
    for (const node of Object.values(page.nodes)) addFrameworkClassIds(used, node.classIds)
  }
  for (const vc of site.visualComponents) {
    addFrameworkClassIds(used, vc.classIds)
    for (const node of Object.values(vc.tree.nodes)) addFrameworkClassIds(used, node.classIds)
  }
  return used
}
