import type { StyleRule } from '@core/page-tree'
import { isGeneratedClassLocked } from '@core/page-tree'
import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice } from './types'

type PropertyActions = Pick<StyleRuleSlice, 'clearClassStyleProperties'>

function removePriorityKeys(rule: StyleRule, keys: readonly string[]): void {
  for (const key of keys) delete rule.stylePriorities?.[key]
  if (rule.stylePriorities && Object.keys(rule.stylePriorities).length === 0) {
    delete rule.stylePriorities
  }
  for (const [contextId, priorities] of Object.entries(rule.contextStylePriorities ?? {})) {
    for (const key of keys) delete priorities[key]
    if (Object.keys(priorities).length === 0) {
      delete rule.contextStylePriorities?.[contextId]
    }
  }
  if (rule.contextStylePriorities && Object.keys(rule.contextStylePriorities).length === 0) {
    delete rule.contextStylePriorities
  }
}

export function createPropertyActions({ get, mutateSite }: SiteSliceHelpers): PropertyActions {
  return {
    clearClassStyleProperties(classId, keys) {
      const { site } = get()
      const cls = site?.styleRules[classId]
      if (!cls) return
      if (isGeneratedClassLocked(cls)) return

      const anySet =
        keys.some((k) => k in cls.styles) ||
        Object.values(cls.contextStyles).some((bag) => keys.some((k) => k in (bag ?? {})))
      if (!anySet) return

      mutateSite((site) => {
        const draftClass = site.styleRules[classId]
        if (!draftClass) return false
        for (const key of keys) {
          delete (draftClass.styles as Record<string, unknown>)[key]
          for (const bag of Object.values(draftClass.contextStyles)) {
            if (bag) delete (bag as Record<string, unknown>)[key]
          }
        }
        removePriorityKeys(draftClass, keys)
        draftClass.updatedAt = Date.now()
        return true
      })
    },
  }
}
