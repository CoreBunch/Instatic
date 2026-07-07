/**
 * Page write diff validator for PUT /admin/api/cms/pages.
 *
 * The pages endpoint owns both dangerous roster reconciliation and ordinary
 * node edits. A coarse `site.structure.edit` gate protects deletion, but it
 * also blocks the copy-editor role from saving text/image/link edits because
 * page trees now live in data_rows instead of the site shell.
 *
 * This validator splits an already-validated partial page write by category:
 *   - structure: page roster, page metadata, node topology, module identity,
 *                non-content module props.
 *   - content:   props whose module schema marks them content-editable.
 *   - style:     class assignments, inline styles, breakpoint overrides.
 */
import type { CoreCapability } from '../../auth/capabilities'
import { ForbiddenSiteChangeError } from './siteDiff'
import { registry, resolvePropertyControlCategory } from '@core/module-engine'
import type { Page, PageNode } from '@core/page-tree'
import '@modules/base'

type PageChangeKind = 'structure' | 'content' | 'style'

const CAP_FOR_KIND: Record<PageChangeKind, CoreCapability> = {
  structure: 'site.structure.edit',
  content: 'site.content.edit',
  style: 'site.style.edit',
}

interface PageDiffInput {
  previousPages: readonly Page[]
  changedPages: readonly Page[]
  deletedPageIds: ReadonlySet<string>
  capabilities: readonly CoreCapability[]
}

function allowed(capabilities: readonly CoreCapability[], kind: PageChangeKind): boolean {
  return capabilities.includes(CAP_FOR_KIND[kind])
}

function requireChange(
  capabilities: readonly CoreCapability[],
  kind: PageChangeKind,
  path: string,
  detail: string,
): void {
  if (!allowed(capabilities, kind)) {
    throw new ForbiddenSiteChangeError(kind, path, detail)
  }
}

export function validatePageWriteDiff({
  previousPages,
  changedPages,
  deletedPageIds,
  capabilities,
}: PageDiffInput): void {
  if (
    capabilities.includes('site.structure.edit') &&
    capabilities.includes('site.content.edit') &&
    capabilities.includes('site.style.edit')
  ) {
    return
  }

  if (deletedPageIds.size > 0) {
    requireChange(
      capabilities,
      'structure',
      'pageIds',
      `pages deleted ${Array.from(deletedPageIds).join(', ')}`,
    )
  }

  const previousById = new Map(previousPages.map((page) => [page.id, page]))
  for (const page of changedPages) {
    const previous = previousById.get(page.id)
    if (!previous) {
      requireChange(capabilities, 'structure', `pages.${page.id}`, 'page created')
      continue
    }
    diffPage(capabilities, previous, page)
  }
}

function diffPage(capabilities: readonly CoreCapability[], previous: Page, next: Page): void {
  const pagePath = `pages.${next.id}`

  if (previous.slug !== next.slug) {
    requireChange(capabilities, 'structure', `${pagePath}.slug`, `${previous.slug} -> ${next.slug}`)
  }
  if (previous.title !== next.title) {
    requireChange(capabilities, 'structure', `${pagePath}.title`, 'page title changed')
  }
  if (previous.rootNodeId !== next.rootNodeId) {
    requireChange(capabilities, 'structure', `${pagePath}.rootNodeId`, 'root node changed')
  }
  if (!deepEqual(previous.template, next.template)) {
    requireChange(capabilities, 'structure', `${pagePath}.template`, 'template settings changed')
  }

  diffNodes(capabilities, pagePath, previous.nodes, next.nodes)
}

function diffNodes(
  capabilities: readonly CoreCapability[],
  pagePath: string,
  previous: Record<string, PageNode>,
  next: Record<string, PageNode>,
): void {
  const nodeIds = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const nodeId of nodeIds) {
    const prevNode = previous[nodeId]
    const nextNode = next[nodeId]
    const nodePath = `${pagePath}.nodes.${nodeId}`

    if (!prevNode || !nextNode) {
      requireChange(capabilities, 'structure', nodePath, prevNode ? 'node removed' : 'node added')
      continue
    }

    diffNode(capabilities, nodePath, prevNode, nextNode)
  }
}

function diffNode(
  capabilities: readonly CoreCapability[],
  nodePath: string,
  previous: PageNode,
  next: PageNode,
): void {
  if (previous.moduleId !== next.moduleId) {
    requireChange(capabilities, 'structure', `${nodePath}.moduleId`, 'module changed')
    return
  }

  if (!deepEqual(previous.children, next.children)) {
    requireChange(capabilities, 'structure', `${nodePath}.children`, 'children changed')
  }
  if (!deepEqual(previous.label, next.label)) {
    requireChange(capabilities, 'structure', `${nodePath}.label`, 'label changed')
  }
  if (!deepEqual(previous.locked, next.locked)) {
    requireChange(capabilities, 'structure', `${nodePath}.locked`, 'locked flag changed')
  }
  if (!deepEqual(previous.hidden, next.hidden)) {
    requireChange(capabilities, 'structure', `${nodePath}.hidden`, 'hidden flag changed')
  }
  if (!deepEqual(previous.propBindings, next.propBindings)) {
    requireChange(capabilities, 'structure', `${nodePath}.propBindings`, 'prop bindings changed')
  }
  if (!deepEqual(previous.dynamicBindings, next.dynamicBindings)) {
    requireChange(capabilities, 'structure', `${nodePath}.dynamicBindings`, 'dynamic bindings changed')
  }

  if (!deepEqual(previous.classIds, next.classIds)) {
    requireChange(capabilities, 'style', `${nodePath}.classIds`, 'class assignments changed')
  }
  if (!deepEqual(previous.inlineStyles, next.inlineStyles)) {
    requireChange(capabilities, 'style', `${nodePath}.inlineStyles`, 'inline styles changed')
  }
  if (!deepEqual(previous.breakpointOverrides, next.breakpointOverrides)) {
    requireChange(capabilities, 'style', `${nodePath}.breakpointOverrides`, 'breakpoint overrides changed')
  }

  diffNodeProps(capabilities, nodePath, previous, next)
}

function diffNodeProps(
  capabilities: readonly CoreCapability[],
  nodePath: string,
  previous: PageNode,
  next: PageNode,
): void {
  const propKeys = new Set([...Object.keys(previous.props), ...Object.keys(next.props)])
  for (const propKey of propKeys) {
    if (deepEqual(previous.props[propKey], next.props[propKey])) continue
    const kind = propChangeKind(previous.moduleId, propKey)
    requireChange(capabilities, kind, `${nodePath}.props.${propKey}`, 'prop changed')
  }
}

function propChangeKind(moduleId: string, propKey: string): PageChangeKind {
  const control = registry.get(moduleId)?.schema[propKey]
  if (!control) return 'structure'
  return resolvePropertyControlCategory(control) === 'content' ? 'content' : 'structure'
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false

  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false
    }
  }
  return true
}
