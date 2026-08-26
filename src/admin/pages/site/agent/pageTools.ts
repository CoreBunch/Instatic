/**
 * Browser-side runners for the page-lifecycle tools — add, delete, rename,
 * duplicate, and the template conversions.
 *
 * Extracted from `executor.ts` when that file crossed the module-size ceiling,
 * following the split already used by `cssTools.ts`, `codeAssetTools.ts`, and
 * `componentTools.ts`: the executor stays a dispatch table, each domain owns
 * its runners.
 *
 * Every runner re-checks that the target page exists before delegating. The
 * store actions are no-ops on an unknown id, which a tool caller would read as
 * success — the same reason the component runners re-check their preconditions.
 */

import {
  aiToolError,
  aiToolOk,
  type AiToolOutput,
  type AddPageInput,
  type ClearPageTemplateInput,
  type DeletePageInput,
  type DuplicatePageInput,
  type RenamePageInput,
  type SetPageTemplateInput,
} from '@core/ai'
import type { PageTemplateConfig } from '@core/page-tree'
import type { EditorStore } from '@site/store/types'
import { getAgentStoreApi } from './storeRef'

// Live access to the editor store. Routed through `./storeRef` so this module
// has no static import edge back into the store module.
const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

export function runAddPage(input: AddPageInput): AiToolOutput {
  const page = getStoreState().addPage(input.title, input.slug)
  // rootNodeId is the parent to pass to insertHtml — a pageId is NOT a node id.
  // addPage also makes the new page active, so the insert targets it.
  return aiToolOk({ pageId: page.id, rootNodeId: page.rootNodeId })
}

export function runDeletePage(input: DeletePageInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')
  if (!site.pages.some((p) => p.id === input.pageId)) {
    return aiToolError(`Page not found: ${input.pageId}`)
  }
  if (site.pages.length <= 1) {
    return aiToolError('Cannot delete the last page in a site.')
  }
  store.deletePage(input.pageId)
  return aiToolOk()
}

export function runRenamePage(input: RenamePageInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')
  if (!site.pages.some((p) => p.id === input.pageId)) {
    return aiToolError(`Page not found: ${input.pageId}`)
  }
  store.renamePage(input.pageId, input.title, input.slug)
  return aiToolOk()
}

export function runDuplicatePage(input: DuplicatePageInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')
  if (!site.pages.some((p) => p.id === input.pageId)) {
    return aiToolError(`Page not found: ${input.pageId}`)
  }
  const newPage = store.duplicatePage(input.pageId, input.title, input.slug)
  return aiToolOk({ pageId: newPage.id })
}

export function runSetPageTemplate(input: SetPageTemplateInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')
  if (!site.pages.some((p) => p.id === input.pageId)) {
    return aiToolError(`Page not found: ${input.pageId}`)
  }
  const config: PageTemplateConfig = {
    enabled: true,
    target: input.target,
    priority: input.priority ?? 100,
  }
  store.convertPageToTemplate(input.pageId, config)
  return aiToolOk()
}

export function runClearPageTemplate(input: ClearPageTemplateInput): AiToolOutput {
  const store = getStoreState()
  const site = store.site
  if (!site) return aiToolError('No active site.')
  const page = site.pages.find((p) => p.id === input.pageId)
  if (!page) return aiToolError(`Page not found: ${input.pageId}`)
  if (!page.template) {
    return aiToolError(`Page is not a template: ${input.pageId}`)
  }
  store.convertTemplateToPage(input.pageId)
  return aiToolOk()
}
