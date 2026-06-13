/**
 * styleRule slice — "clear this property everywhere" affordances:
 * removeClassStyleProperty (one property) and clearClassStyleProperties
 * (a group, one undo step). Both prune from base styles AND every per-context
 * override so a cleared property truly disappears regardless of active context.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { isGeneratedClassLocked } from '@core/page-tree'
import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice } from './types'

type PropertyActions = Pick<
  StyleRuleSlice,
  'removeClassStyleProperty' | 'clearClassStyleProperties'
>

export function createPropertyActions({ get, mutateSite }: SiteSliceHelpers): PropertyActions {
  return {
    removeClassStyleProperty(classId, property: keyof CSSPropertyBag) {
      const { site } = get()
      const cls = site?.styleRules[classId]
      if (!cls) return
      if (isGeneratedClassLocked(cls)) return

      const propKey = property as string
      const isInBase = propKey in cls.styles
      // Every per-context override (viewport contexts AND custom conditions) lives
      // in one map now — "clear everywhere" iterates it uniformly.
      const contextIdsWithProperty = Object.entries(cls.contextStyles)
        .filter(([, bag]) => propKey in (bag ?? {}))
        .map(([id]) => id)
      if (!isInBase && contextIdsWithProperty.length === 0) {
        return
      }

      mutateSite((site) => {
        const draftClass = site.styleRules[classId]
        if (!draftClass) return false
        delete (draftClass.styles as Record<string, unknown>)[propKey]
        for (const contextId of contextIdsWithProperty) {
          const bag = draftClass.contextStyles[contextId]
          if (bag) delete (bag as Record<string, unknown>)[propKey]
        }
        draftClass.updatedAt = Date.now()
        return true
      })
    },

    clearClassStyleProperties(classId, properties) {
      const { site } = get()
      const cls = site?.styleRules[classId]
      if (!cls) return
      if (isGeneratedClassLocked(cls)) return

      const keys = properties.map((p) => p as string)
      // Determine whether anything is actually set, so a no-op clear doesn't push
      // an empty history entry (mirrors removeClassStyleProperty's guard).
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
        draftClass.updatedAt = Date.now()
        return true
      })
    },
  }
}
