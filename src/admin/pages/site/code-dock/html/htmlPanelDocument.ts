/**
 * htmlPanelDocument — what the God Mode HTML panel projects, derived from
 * editor state:
 *
 *   - an element selected in the active tree → that subtree;
 *   - nothing selected → the whole active document (page, or the Component
 *     definition in VC canvas mode — both fully editable);
 *   - a node selected INSIDE a Component instance on the consumer side (the
 *     canvas renders definition internals, so their ids can be selected while
 *     a page is active) → that subtree from the definition, READ-ONLY, with a
 *     jump to the definition where it can be edited.
 *
 * The HTML is the publisher's editable projection (`RenderConfig.projection`):
 * every element carries `uid="<nodeId>"`, tokens stay verbatim, structural
 * modules render as `instatic-*` markers — the dialect `importProjectionHtml`
 * parses back — reflowed for reading by `prettyPrintProjection`.
 */
import { registry } from '@core/module-engine'
import type { NodeTree, Page, PageNode } from '@core/page-tree'
import { renderNode, type RenderAccumulators, type RenderConfig } from '@core/publisher'
import { flattenVCToVirtualPage } from '@core/visualComponents'
import type { EditorStore } from '@site/store/types'
import type { SelectionScopeInputs } from '../selectionScope'
import { prettyPrintProjection } from './prettyProjection'

export interface HtmlPanelDocument {
  /** Identity of the projected document — changes when the scope changes. */
  docKey: string
  /** The projection dialect HTML for `rootId`. */
  html: string
  /** Splice point for `importProjectionHtml` / `applyProjectionImport`. */
  rootId: string
  /** The tree `rootId` lives in — the base tree for the import. */
  tree: NodeTree<PageNode>
  /** Component-instance internals on the consumer side: view only. */
  readOnly: boolean
  /** The Component whose definition holds a read-only selection. */
  definitionVcId: string | null
}

function renderProjection(page: Page, site: NonNullable<EditorStore['site']>, rootId: string): string {
  const config: RenderConfig = { page, site, registry, breakpointId: undefined, projection: true }
  const acc: RenderAccumulators = {
    cssMap: new Map(),
    jsMap: new Map(),
    infiniteLoopIds: new Set(),
    holeNodeIds: new Set(),
    cspSources: new Map(),
  }
  return prettyPrintProjection(renderNode(rootId, config, acc))
}

export function deriveHtmlPanelDocument(inputs: SelectionScopeInputs): HtmlPanelDocument | null {
  const { site, activeDocument, activePageId, selectedNodeId } = inputs
  if (!site) return null

  const activeVc =
    activeDocument?.kind === 'visualComponent'
      ? site.visualComponents.find((vc) => vc.id === activeDocument.vcId) ?? null
      : null
  const activePage = activeVc ? null : site.pages.find((p) => p.id === activePageId) ?? null
  const renderPage = activeVc ? flattenVCToVirtualPage(activeVc) : activePage
  const tree: NodeTree<PageNode> | null = activeVc ? (activeVc.tree as NodeTree<PageNode>) : activePage
  if (!renderPage || !tree) return null

  if (selectedNodeId && tree.nodes[selectedNodeId]) {
    return {
      docKey: `html:node:${selectedNodeId}`,
      html: renderProjection(renderPage, site, selectedNodeId),
      rootId: selectedNodeId,
      tree,
      readOnly: false,
      definitionVcId: null,
    }
  }

  if (selectedNodeId) {
    // Consumer-side Component internals: the selection lives in a definition
    // tree while a page (or another Component) is the active document.
    const owner = site.visualComponents.find((vc) => vc.tree.nodes[selectedNodeId])
    if (owner) {
      return {
        docKey: `html:internal:${selectedNodeId}`,
        html: renderProjection(flattenVCToVirtualPage(owner), site, selectedNodeId),
        rootId: selectedNodeId,
        tree: owner.tree as NodeTree<PageNode>,
        readOnly: true,
        definitionVcId: owner.id,
      }
    }
  }

  return {
    docKey: activeVc ? `html:vc:${activeVc.id}` : `html:page:${renderPage.id}`,
    html: renderProjection(renderPage, site, tree.rootNodeId),
    rootId: tree.rootNodeId,
    tree,
    readOnly: false,
    definitionVcId: null,
  }
}
