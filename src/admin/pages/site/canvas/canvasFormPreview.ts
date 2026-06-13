/**
 * canvasFormPreview — editor-only preview state for `base.form` /
 * `base.form-message` nodes.
 *
 * The Properties panel lets authors preview a form's `submitting` / `success`
 * / `error` states without submitting anything. The preview state is stored
 * per FORM node (`formPreviewStates[formNodeId]`), so a `base.form-message`
 * node must resolve its nearest enclosing form to find its state.
 *
 * Both resolvers run inside per-node Zustand selectors (NodeRenderer mounts
 * one of each per canvas node), and Zustand re-runs every subscriber's
 * selector on every store set — so everything here must be cheap on the
 * cache-hit path and must return referentially stable values for unchanged
 * data (strings / nulls / nodes from the store).
 */

import type { PageNode } from '@core/page-tree'
import { selectActiveCanvasPage, type EditorStore } from '@site/store/store'

type FormPreviewState = 'default' | 'submitting' | 'success' | 'error'

const DEFAULT_FORM_SUCCESS_MESSAGE = 'Thanks. Your submission was received.'

/**
 * Resolve the editor form-preview state for `nodeId` — `default` unless the
 * node is a form (or a form-message inside one) with an active preview.
 */
export function resolveEditorFormPreviewState(state: EditorStore, nodeId: string): FormPreviewState {
  const formNode = previewedFormNode(state, nodeId)
  if (!formNode) return 'default'
  return state.formPreviewStates[formNode.id] ?? 'default'
}

/** Resolve the success message the form preview should display for `nodeId`. */
export function resolveEditorFormPreviewSuccessMessage(state: EditorStore, nodeId: string): string {
  const formNode = previewedFormNode(state, nodeId)
  return formNode
    ? stringNodeProp(formNode, 'successMessage', DEFAULT_FORM_SUCCESS_MESSAGE)
    : DEFAULT_FORM_SUCCESS_MESSAGE
}

/**
 * Merge the editor preview state into a form module's props. No-op (same
 * props reference) for non-form modules or when no preview is active.
 */
export function addEditorFormPreviewProps(
  moduleId: string,
  props: Record<string, unknown>,
  previewState: FormPreviewState,
  successMessage: string,
): Record<string, unknown> {
  if (previewState === 'default') return props
  if (moduleId !== 'base.form' && moduleId !== 'base.form-message') return props
  return {
    ...props,
    editorPreviewState: previewState,
    editorPreviewSuccessMessage: successMessage,
  }
}

function previewedFormNode(state: EditorStore, nodeId: string): PageNode | null {
  const page = selectActiveCanvasPage(state)
  const node = page?.nodes[nodeId]
  if (!page || !node) return null
  if (node.moduleId === 'base.form') return node
  if (node.moduleId === 'base.form-message') return nearestFormNode(page, nodeId)
  return null
}

// Parent-id index per nodes-map identity. Without the cache every
// form-message node rebuilds the index — an O(page) walk + allocation — in
// BOTH form-preview selectors on every store set in every breakpoint frame.
// The WeakMap keys on `page.nodes`: Mutative structural sharing mints a new
// map identity exactly when the tree changes, so invalidation is automatic.
const parentIndexCache = new WeakMap<Record<string, PageNode>, Map<string, string>>()

function parentIndexFor(nodes: Record<string, PageNode>): Map<string, string> {
  const cached = parentIndexCache.get(nodes)
  if (cached) return cached
  const parentByNodeId = new Map<string, string>()
  for (const node of Object.values(nodes)) {
    for (const childId of node.children) parentByNodeId.set(childId, node.id)
  }
  parentIndexCache.set(nodes, parentByNodeId)
  return parentByNodeId
}

/** Walk up from `nodeId` to the nearest enclosing `base.form` node, if any. */
export function nearestFormNode(
  page: { nodes: Record<string, PageNode> },
  nodeId: string,
): PageNode | null {
  const parentByNodeId = parentIndexFor(page.nodes)
  let currentId = parentByNodeId.get(nodeId)
  while (currentId) {
    const current = page.nodes[currentId]
    if (!current) return null
    if (current.moduleId === 'base.form') return current
    currentId = parentByNodeId.get(current.id)
  }
  return null
}

function stringNodeProp(node: PageNode, key: string, fallback: string): string {
  const value = node.props[key]
  return typeof value === 'string' && value.trim() ? value : fallback
}
