import type { Page, PageTemplateConfig, SiteDocument } from '@core/page-tree'
import type { VCParam, VisualComponent } from '@core/visualComponents'
import type { AgentDocumentRef } from './toolSchemas'

export interface AgentDocumentDescriptor {
  document: AgentDocumentRef
  title: string
  rootNodeId: string
  active: boolean
  current: boolean
  summary: string
  slug?: string
  isHomepage?: boolean
  template?: {
    target: PageTemplateConfig['target']
    priority: number
  }
  /**
   * Visual components only — the param surface each instance can override.
   * Listed here because it is the only place a tool caller can discover param
   * ids, and every param-facing tool (`site_set_component_params`,
   * `site_bind_component_prop`, `propOverrides` on a ref) is keyed by id.
   */
  params?: {
    id: string
    name: string
    type: VCParam['type']
    required: boolean
    enumOptions?: string[]
  }[]
}

export function documentRefForPage(page: Pick<Page, 'id' | 'template'>): AgentDocumentRef {
  return { type: page.template ? 'template' : 'page', id: page.id }
}

export function documentRefEquals(a: AgentDocumentRef | null | undefined, b: AgentDocumentRef): boolean {
  return a?.type === b.type && a.id === b.id
}

export function describeAgentDocuments(
  site: SiteDocument,
  activePageId: string | null,
  currentDocument: AgentDocumentRef | null,
): AgentDocumentDescriptor[] {
  const descriptors: AgentDocumentDescriptor[] = []

  for (const page of site.pages) {
    const document = documentRefForPage(page)
    descriptors.push({
      document,
      title: page.title,
      slug: page.slug,
      rootNodeId: page.rootNodeId,
      active: page.id === activePageId,
      current: documentRefEquals(currentDocument, document),
      isHomepage: page.slug === 'index',
      ...(page.template
        ? { template: { target: page.template.target, priority: page.template.priority } }
        : {}),
      summary: summarizePageDocument(page),
    })
  }

  for (const vc of site.visualComponents ?? []) {
    const document: AgentDocumentRef = { type: 'visualComponent', id: vc.id }
    descriptors.push({
      document,
      title: vc.name,
      rootNodeId: vc.tree.rootNodeId,
      active: false,
      current: documentRefEquals(currentDocument, document),
      params: vc.params.map((param) => ({
        id: param.id,
        name: param.name,
        type: param.type,
        required: param.required,
        ...(param.enumOptions ? { enumOptions: param.enumOptions } : {}),
      })),
      summary: summarizeVisualComponent(vc),
    })
  }

  return descriptors
}

function summarizeVisualComponent(vc: Pick<VisualComponent, 'params'>): string {
  if (vc.params.length === 0) {
    return 'Visual component definition — no params, every instance renders identically'
  }
  const names = vc.params.map((param) => `${param.name}: ${param.type}`)
  return `Visual component definition — params: ${names.join(', ')}`
}

function summarizePageDocument(page: Pick<Page, 'slug' | 'template'>): string {
  if (!page.template) {
    return page.slug === 'index' ? 'Homepage' : `Page /${page.slug}`
  }
  const target = page.template.target
  if (target.kind === 'everywhere') return 'Everywhere template wrapping all pages'
  if (target.kind === 'notFound') return '404 template'
  return `Post type template for ${target.tableSlugs.join(', ')}`
}
