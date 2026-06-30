import {
  aiToolError,
  aiToolOk,
  describeAgentDocuments,
  documentRefEquals,
  documentRefForPage,
  renderAgentDocument,
  type AgentDocumentDescriptor,
  type AgentDocumentRef,
  type AiToolOutput,
  type ReadDocumentInput,
  type OpenDocumentInput,
} from '@core/ai'
import type { BaseNode, Page } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { flattenVCToVirtualPage } from '@core/visualComponents'
import type { EditorStore } from '@site/store/types'

interface ResolvedAgentDocument {
  descriptor: AgentDocumentDescriptor
  page: Page
}

/**
 * The node map of the ACTIVE document — the single tree every write tool
 * actually mutates (`mutateActiveTree`). Page mode -> the active page's nodes;
 * VC mode -> the active component's tree.
 */
export function activeDocumentNodes(store: EditorStore): Record<string, BaseNode> | null {
  const site = store.site
  if (!site) return null
  const activeDocument = store.activeDocument
  if (activeDocument?.kind === 'visualComponent') {
    const vc = site.visualComponents?.find((component) => component.id === activeDocument.vcId)
    return vc ? (vc.tree.nodes as Record<string, BaseNode>) : null
  }
  const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : store.activePageId
  const page = site.pages.find((candidate) => candidate.id === pageId)
  return page ? page.nodes : null
}

/** The active document materialized as a Page for publisher rendering. */
export function activeRenderPage(store: EditorStore): Page | null {
  const site = store.site
  if (!site) return null
  const activeDocument = store.activeDocument
  if (activeDocument?.kind === 'visualComponent') {
    const vc = site.visualComponents?.find((component) => component.id === activeDocument.vcId)
    return vc ? flattenVCToVirtualPage(vc) : null
  }
  const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : store.activePageId
  return site.pages.find((candidate) => candidate.id === pageId) ?? null
}

export function describeForeignNode(store: EditorStore, nodeId: string): string | null {
  const site = store.site
  if (!site) return null
  for (const page of site.pages) {
    if (page.nodes[nodeId]) {
      const kind = page.template ? 'template' : 'page'
      return `the "${page.title}" ${kind} (a different document)`
    }
  }
  for (const vc of site.visualComponents ?? []) {
    if (vc.tree.nodes[nodeId]) return `the "${vc.name}" component (a different document)`
  }
  return null
}

export function focusNodeDocument(store: EditorStore, nodeId: string): void {
  if (activeDocumentNodes(store)?.[nodeId]) return
  const site = store.site
  if (!site) return
  const ownerPage = site.pages.find((page) => page.nodes[nodeId])
  if (ownerPage) {
    store.openPageInCanvas(ownerPage.id)
    return
  }
  const ownerVc = site.visualComponents?.find((vc) => vc.tree.nodes[nodeId])
  if (ownerVc) store.setActiveDocument({ kind: 'visualComponent', vcId: ownerVc.id })
}

export function currentAgentDocument(store: EditorStore): AgentDocumentRef | null {
  const site = store.site
  if (!site) return null
  const activeDocument = store.activeDocument
  if (activeDocument?.kind === 'visualComponent') {
    return { type: 'visualComponent', id: activeDocument.vcId }
  }
  const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : store.activePageId
  const page = site.pages.find((p) => p.id === pageId)
  return page ? documentRefForPage(page) : null
}

export function describeDocumentId(store: EditorStore, id: string): string | null {
  const site = store.site
  if (!site) return null
  const page = site.pages.find((p) => p.id === id)
  if (page) {
    const document = documentRefForPage(page)
    return `ID ${id} is a ${document.type} document id, not a node id. Call site_read_document({ document: { type: "${document.type}", id: "${id}" } }) and use a returned uid.`
  }
  const vc = site.visualComponents?.find((component) => component.id === id)
  if (vc) {
    return `ID ${id} is a visualComponent document id, not a node id. Call site_read_document({ document: { type: "visualComponent", id: "${id}" } }) and use a returned uid.`
  }
  return null
}

export function runReadDocument(input: ReadDocumentInput, store: EditorStore): AiToolOutput {
  const resolved = resolveAgentDocument(store, input.document)
  if (!resolved) {
    return aiToolError('Document not found. Call list_documents and pass one of its document refs.')
  }
  const rendered = renderAgentDocument(resolved.page, store.site!, registry, { part: input.part })
  return aiToolOk({
    document: resolved.descriptor.document,
    title: resolved.descriptor.title,
    html: rendered.html,
    css: rendered.css,
    pageInfo: rendered.pageInfo,
  })
}

export function runOpenDocument(input: OpenDocumentInput, store: EditorStore): AiToolOutput {
  const resolved = resolveAgentDocument(store, input.document)
  if (!resolved) {
    return aiToolError('Document not found. Call list_documents and pass one of its document refs.')
  }
  const document = resolved.descriptor.document
  if (document.type === 'visualComponent') {
    store.setActiveDocument({ kind: 'visualComponent', vcId: document.id })
  } else {
    store.openPageInCanvas(document.id)
  }
  return aiToolOk({ document })
}

function resolveAgentDocument(
  store: EditorStore,
  requested: AgentDocumentRef | undefined,
): ResolvedAgentDocument | null {
  const site = store.site
  const current = currentAgentDocument(store)
  const activePageId = store.activePageId
  if (!site || !current || !activePageId) return null

  const document = requested ?? current
  const descriptors = describeAgentDocuments(site, activePageId, current)

  if (document.type === 'visualComponent') {
    const vc = site.visualComponents?.find((component) => component.id === document.id)
    if (!vc) return null
    const descriptor = descriptors.find((item) => documentRefEquals(item.document, {
      type: 'visualComponent',
      id: vc.id,
    }))
    if (!descriptor) return null
    return { descriptor, page: flattenVCToVirtualPage(vc) }
  }

  const page = site.pages.find((candidate) => candidate.id === document.id)
  if (!page) return null
  const actualRef = documentRefForPage(page)
  const descriptor = descriptors.find((item) => documentRefEquals(item.document, actualRef))
  if (!descriptor) return null
  return { descriptor, page }
}
