import type { EditorStore } from '@site/store/types'
import { canLocalizeEditorProperty, extractLocalizedTreeChanges, LocalizationValidationError } from '@core/localization'
import { activeRenderPage } from './documentTools'
import { LOCALIZED_SITE_MUTATION_TOOLS, SITE_MUTATION_TOOLS } from './toolClassification'

function isTranslation(store: EditorStore): boolean {
  return Boolean(store.site?.localization && store.activeLocaleId !== store.site.locales?.find((locale) => locale.isDefault)?.id)
}

/** Report a tool error before a store guard refuses shared edits in translation mode. */
export function assertLocalizedSiteTool(toolName: string, store: EditorStore): void {
  if (isTranslation(store) && SITE_MUTATION_TOOLS.has(toolName) && !LOCALIZED_SITE_MUTATION_TOOLS.has(toolName)) {
    throw new LocalizationValidationError('localeId', 'Shared structure, design and code must be edited in the source language. Select the source locale before making this change.')
  }
}

export function assertLocalizedNodePatch(
  store: EditorStore,
  nodeId: string,
  patch: Record<string, unknown>,
  breakpointId?: string,
): void {
  if (!isTranslation(store) || !store.site) return
  if (breakpointId) throw new LocalizationValidationError('breakpointId', 'Shared responsive design must be edited in the source language.')
  const tree = activeRenderPage(store)
  if (!tree?.nodes[nodeId]) throw new LocalizationValidationError('nodeId', 'This node is not in the active document.')
  const tableId = store.activeDocument?.kind === 'visualComponent' ? 'components' : 'pages'
  if (store.site.localization?.fieldLocalizations[tableId]?.body === 'shared') {
    throw new LocalizationValidationError('body', 'This tree is shared across languages. Edit its content in the source language.')
  }
  const after = {
    ...tree,
    nodes: { ...tree.nodes, [nodeId]: { ...tree.nodes[nodeId], props: { ...tree.nodes[nodeId].props, ...patch } } },
  }
  extractLocalizedTreeChanges(tree, after, {}, (node, key) => canLocalizeEditorProperty(store.site!, node, key))
}
