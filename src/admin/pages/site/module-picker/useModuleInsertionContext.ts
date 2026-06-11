import { isTemplatePage, treeHasOutlet } from '@core/templates'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { ModuleInsertionContext } from './moduleInserterModel'

/**
 * The insertion context for the active canvas document — feeds
 * `moduleAvailability` so every picker surface (inserter dialog, context-menu
 * picker, notch favorites) applies identical hidden/disabled rules.
 */
export function useModuleInsertionContext(): ModuleInsertionContext {
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const canvasPage = useEditorStore(selectActiveCanvasPage)
  const isVCMode = activeDocument?.kind === 'visualComponent'
  return {
    isVCMode,
    activeVcId: activeDocument?.kind === 'visualComponent' ? activeDocument.vcId : null,
    isTemplate: !isVCMode && canvasPage !== null && isTemplatePage(canvasPage),
    hasOutlet: canvasPage !== null && treeHasOutlet(canvasPage),
  }
}
