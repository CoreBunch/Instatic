import type { Page, PageNode, SiteDocument } from '@core/page-tree'
import { parseTokenString, publishedRenderScopes } from '@core/templates'
import { walkRenderTree } from '@core/visualComponents'

export interface LoopRenderScope {
  node: PageNode
  nodes: Readonly<Record<string, PageNode>>
  nested: boolean
}

const SOURCE_CONFIGURATION_KEYS = ['sourceId', 'filters', 'orderBy', 'direction', 'limit', 'offset', 'pagination', 'pageSize'] as const
type LoopScopeIssue = { kind: 'nested' | 'duplicate' } | { kind: 'binding'; propKey: typeof SOURCE_CONFIGURATION_KEYS[number]; property: 'props' | 'dynamicBindings' }

export class LoopScopeConfigurationError extends Error {
  readonly path: string

  constructor(page: Page, scope: LoopRenderScope, issue: LoopScopeIssue) {
    const detail = issue.kind === 'binding'
      ? `has a dynamic binding on authored source configuration "${issue.propKey}"; source configuration is fixed before prefetch`
      : issue.kind === 'nested'
      ? 'is inside another loop; infinite loading requires a route-level entry context'
      : 'has multiple instances on the same public page; infinite loading requires a unique loop id'
    const name = issue.kind === 'binding' ? 'Loop' : 'Infinite loop'
    super(`${name} "${scope.node.id}" on page "${page.title}" ${detail}`)
    this.name = 'LoopScopeConfigurationError'
    const property = issue.kind === 'binding' ? `${issue.property}.${issue.propKey}` : 'props.pagination'
    this.path = `pages.${page.id}.nodes.${scope.node.id}.${property}`
  }
}

/** The effective native tree owns both publication checks and fragment lookup. */
export function collectLoopRenderScopes(page: Page, site: SiteDocument): LoopRenderScope[] {
  const result: LoopRenderScope[] = []
  walkRenderTree(page.nodes, page.rootNodeId, site.visualComponents, (node, frame) => {
    if (node.moduleId !== 'base.loop') return
    result.push({ node, nodes: frame.nodes, nested: frame.ancestors.some((ancestor) => ancestor.moduleId === 'base.loop') })
  })
  return result
}

/** An entry route's initial stack is supported; an outer loop's iteration is not. */
export function assertLoopRenderScopes(page: Page, scopes: readonly LoopRenderScope[]): void {
  const counts = new Map<string, number>()
  for (const scope of scopes) counts.set(scope.node.id, (counts.get(scope.node.id) ?? 0) + 1)
  for (const scope of scopes) {
    for (const propKey of SOURCE_CONFIGURATION_KEYS) {
      if (scope.node.dynamicBindings?.[propKey]) {
        throw new LoopScopeConfigurationError(page, scope, { kind: 'binding', propKey, property: 'dynamicBindings' })
      }
      const value = scope.node.props[propKey]
      if (typeof value === 'string' && parseTokenString(value).some((segment) => segment.kind === 'token')) {
        throw new LoopScopeConfigurationError(page, scope, { kind: 'binding', propKey, property: 'props' })
      }
    }
    if (scope.node.props.pagination !== 'infinite') continue
    if (scope.nested) throw new LoopScopeConfigurationError(page, scope, { kind: 'nested' })
    if (counts.get(scope.node.id)! > 1) throw new LoopScopeConfigurationError(page, scope, { kind: 'duplicate' })
  }
}

export function assertPageLoopScopes(page: Page, site: SiteDocument): void {
  assertLoopRenderScopes(page, collectLoopRenderScopes(page, site))
}

/** Raw unused templates/components and hidden or orphan nodes are not public scopes. */
export function assertSiteLoopScopes(site: SiteDocument): void {
  for (const scope of publishedRenderScopes(site)) assertPageLoopScopes(scope.page, site)
}
