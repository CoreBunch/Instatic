import type { Page, PageTemplateConfig, SiteDocument } from '@core/page-tree'
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
      summary: 'Visual component definition',
    })
  }

  return descriptors
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
