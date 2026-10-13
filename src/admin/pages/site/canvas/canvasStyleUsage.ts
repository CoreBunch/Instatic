import { collectPageStyleRuleIds } from '@core/publisher'
import { getAncestors } from '@core/page-tree'
import { collectRuntimeScripts, normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { selectActiveCanvasPage } from '@site/store/store'
import type { EditorStore } from '@site/store/types'

/**
 * One usage analysis per relevant immutable snapshot, shared by breakpoint
 * frames. Selection/hover or edits to another page do not repeat the walk;
 * temporary class assignments only extend the cached usage set.
 * The result is a primitive so Zustand subscriptions remain stable.
 */
export function createCanvasStyleRuleIdSelector(): (state: EditorStore) => string {
  let lastInputs: ReadonlyArray<unknown> | null = null
  let usedIds = new Set<string>()
  let lastPreview: EditorStore['previewClassAssignment'] = null
  let lastSignature = ''
  return (state) => {
    const { site, runScripts } = state
    const page = selectActiveCanvasPage(state)
    const inputs = [page, site?.visualComponents, site?.styleRules, site?.files, site?.runtime, runScripts]
    const usageChanged = !lastInputs || !inputs.every((input, index) => input === lastInputs![index])
    const preview = state.previewClassAssignment
    if (!usageChanged && preview === lastPreview) return lastSignature
    lastPreview = preview
    if (usageChanged) {
      lastInputs = inputs
      const scripts = site && page && runScripts ? collectRuntimeScripts({
        files: site.files,
        runtime: normalizeSiteRuntimeConfig(site.runtime),
        page,
        target: 'canvas',
      }).map(({ file, config }) => ({ fileId: file.id, format: config.format ?? 'module' })) : []
      usedIds = site && page ? collectPageStyleRuleIds(site, page, scripts) : new Set()
    }
    const ids = [...usedIds]
    if (page && preview && !usedIds.has(preview.classId)) {
      const node = page.nodes[preview.nodeId]
      const ancestors = getAncestors(page, preview.nodeId)
      if (node && !node.hidden && !ancestors.some((ancestor) => ancestor.hidden)
        && (node.id === page.rootNodeId || ancestors[0]?.id === page.rootNodeId)) {
        ids.push(preview.classId)
      }
    }
    lastSignature = ids.sort().join('\0')
    return lastSignature
  }
}
