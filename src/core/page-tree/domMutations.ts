import { nanoid } from 'nanoid'
import type { IModuleRegistry } from '@core/module-engine'
import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'

/**
 * Create a DOM-native node — one that stores actual HTML structure (`tag`,
 * `attributes`, `textContent`) instead of module props. The publisher
 * serialises these directly to HTML without calling a module `render()`.
 *
 * Either `textContent` (leaf text node) or `children` (element children) is
 * valid, but not both — `textContent` is only for leaf nodes.
 *
 * When `moduleOverlay` is provided, the node carries BOTH the canonical HTML
 * structure AND a module reference for structured editing UX. The overlay's
 * `moduleId` is the real module; the top-level `moduleId` stays empty so
 * `isDomNode()` returns true and the publisher/canvas treat it as a
 * DOM-native node that happens to have an overlay.
 */
export function createDomNode(
  tag: string,
  options: {
    attributes?: Record<string, string>
    textContent?: string
    classIds?: string[]
    inlineStyles?: Record<string, unknown>
    moduleOverlay?: { moduleId: string; props: Record<string, unknown> }
  } = {},
): PageNode {
  const node: PageNode = {
    id: nanoid(),
    moduleId: '',
    tag,
    props: {},
    breakpointOverrides: {},
    children: [],
    classIds: options.classIds ?? [],
    parentId: null,
  }
  if (options.attributes) node.attributes = { ...options.attributes }
  if (options.textContent !== undefined) node.textContent = options.textContent
  if (options.inlineStyles) node.inlineStyles = { ...options.inlineStyles }
  if (options.moduleOverlay) node.moduleOverlay = { ...options.moduleOverlay }
  return node
}

/** Re-compute tag / attributes / textContent from the moduleOverlay's htmlContract.
 *  Call this after mutating moduleOverlay.props so the DOM-native fields stay in sync.
 */
export function syncModuleOverlayHtmlFields(
  tree: NodeTree<PageNode>,
  nodeId: string,
  registry: IModuleRegistry,
): void {
  const node = tree.nodes[nodeId]
  if (!node || !node.moduleOverlay) return
  const def = registry.get(node.moduleOverlay.moduleId)
  if (!def?.htmlContract) return
  const contract = def.htmlContract
  const props = node.moduleOverlay.props

  // Sync tag
  if (contract.tag) {
    const nextTag = typeof contract.tag === 'function' ? contract.tag(props as never) : contract.tag
    if (nextTag) node.tag = nextTag
  }

  // Sync attributes — contract wins for keys it declares; unknown attrs are preserved.
  if (contract.attributes) {
    const contractAttrs = contract.attributes(props as never)
    const preserved: Record<string, string> = {}
    for (const [key, value] of Object.entries(node.attributes ?? {})) {
      if (!(key in contractAttrs)) {
        preserved[key] = value
      }
    }
    node.attributes = { ...preserved, ...contractAttrs }
  }

  // Sync textContent (only for leaf modules that declare it)
  if (contract.textContent) {
    node.textContent = contract.textContent(props as never)
  }
}
