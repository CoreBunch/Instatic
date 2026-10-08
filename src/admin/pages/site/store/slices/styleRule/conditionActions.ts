/**
 * styleRule slice — site-level reusable conditions (custom @media / @container
 * / @supports) and the per-class hooks into them: addCondition,
 * removeCondition, renameCondition, updateCondition, addClassCondition,
 * removeClassContext.
 */

import type { Condition, StyleRule } from '@core/page-tree'
import { conditionId, makeConditionDef } from '@core/page-tree'
import { isGeneratedClassLocked } from '@core/page-tree'
import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice } from './types'
import { removeStyleRuleReferences } from './helpers'

type ConditionActions = Pick<
  StyleRuleSlice,
  | 'addCondition'
  | 'removeCondition'
  | 'renameCondition'
  | 'updateCondition'
  | 'addClassCondition'
  | 'removeClassContext'
>

function hasGroupedContext(rule: StyleRule, contextId: string): boolean {
  return (
    (rule.grouping ?? []).some(
      (group) => group.kind === 'context' && group.contextId === contextId,
    ) ||
    (rule.atRule?.kind === 'group' &&
      rule.atRule.group.kind === 'context' &&
      rule.atRule.group.contextId === contextId)
  )
}

/** Removing an outer condition removes its whole fragment, never lifts it into base CSS. */
function clearGroupedFragment(rule: StyleRule): void {
  rule.styles = {}
  rule.contextStyles = {}
  delete rule.stylePriorities
  delete rule.contextStylePriorities
  delete rule.grouping
  delete rule.atRule
  delete rule.rawCss
  rule.updatedAt = Date.now()
}

export function createConditionActions({
  get,
  mutateSite,
  mutateSiteState,
}: SiteSliceHelpers): ConditionActions {
  return {
    addCondition(condition: Condition, label?: string) {
      const def = makeConditionDef(condition, label)
      const { site } = get()
      if (!site) return def.id
      if ((site.conditions ?? []).some((c) => c.id === def.id)) return def.id

      mutateSite((site) => {
        if (!site.conditions) site.conditions = []
        if (site.conditions.some((c) => c.id === def.id)) return false
        site.conditions.push(def)
        return true
      })
      return def.id
    },

    removeCondition(condId) {
      const { site } = get()
      if (!site) return
      const exists = (site.conditions ?? []).some((c) => c.id === condId)
      const usedByAnyClass = Object.values(site.styleRules).some(
        (cls) => condId in cls.contextStyles || hasGroupedContext(cls, condId),
      )
      if (!exists && !usedByAnyClass) return

      mutateSiteState((state, site) => {
        if (site.conditions) {
          site.conditions = site.conditions.filter((c) => c.id !== condId)
          if (site.conditions.length === 0) delete site.conditions
        }
        const removed = new Set<string>()
        for (const cls of Object.values(site.styleRules)) {
          if (hasGroupedContext(cls, condId)) {
            if (cls.kind === 'class') clearGroupedFragment(cls)
            else {
              delete site.styleRules[cls.id]
              removed.add(cls.id)
            }
          } else if (condId in cls.contextStyles) {
            delete cls.contextStyles[condId]
            delete cls.contextStylePriorities?.[condId]
            if (
              cls.contextStylePriorities &&
              Object.keys(cls.contextStylePriorities).length === 0
            ) {
              delete cls.contextStylePriorities
            }
            cls.updatedAt = Date.now()
          }
        }
        removeStyleRuleReferences(state, site, removed)
        return true
      })
    },

    renameCondition(condId, label) {
      const { site } = get()
      if (!site) return
      const trimmed = label.trim()
      if (!trimmed) return
      const current = (site.conditions ?? []).find((c) => c.id === condId)
      if (!current || current.label === trimmed) return

      mutateSite((site) => {
        const def = site.conditions?.find((c) => c.id === condId)
        if (!def || def.label === trimmed) return false
        def.label = trimmed
        return true
      })
    },

    updateCondition(condId, condition, label) {
      const { site } = get()
      if (!site) return
      const current = (site.conditions ?? []).find((c) => c.id === condId)
      if (!current) return

      mutateSite((site) => {
        const def = site.conditions?.find((c) => c.id === condId)
        if (!def) return false
        def.condition = condition
        if (label && label.trim()) def.label = label.trim()
        return true
      })
    },

    addClassCondition(classId, condition) {
      const { site } = get()
      const cls = site?.styleRules[classId]
      if (!cls) return null
      if (isGeneratedClassLocked(cls)) return null

      const id = conditionId(condition)
      const def = makeConditionDef(condition)
      mutateSite((site) => {
        if (!site.conditions) site.conditions = []
        if (!site.conditions.some((c) => c.id === id)) site.conditions.push(def)
        const draftClass = site.styleRules[classId]
        if (!draftClass) return false
        // Ensure an (initially empty) override bag exists so the context surfaces
        // as an editable tab even before any property is set under it.
        if (!draftClass.contextStyles[id]) {
          draftClass.contextStyles[id] = {}
          draftClass.updatedAt = Date.now()
        }
        return true
      })
      return id
    },

    removeClassContext(classId, contextId) {
      const { site } = get()
      const cls = site?.styleRules[classId]
      if (!cls) return
      if (isGeneratedClassLocked(cls)) return
      if (!(contextId in cls.contextStyles) && !hasGroupedContext(cls, contextId)) return

      mutateSiteState((state, site) => {
        const draftClass = site.styleRules[classId]
        if (!draftClass) return false
        if (hasGroupedContext(draftClass, contextId)) {
          if (draftClass.kind === 'class') clearGroupedFragment(draftClass)
          else {
            delete site.styleRules[classId]
            removeStyleRuleReferences(state, site, new Set([classId]))
          }
          return true
        }
        if (!(contextId in draftClass.contextStyles)) return false
        delete draftClass.contextStyles[contextId]
        delete draftClass.contextStylePriorities?.[contextId]
        if (
          draftClass.contextStylePriorities &&
          Object.keys(draftClass.contextStylePriorities).length === 0
        ) {
          delete draftClass.contextStylePriorities
        }
        draftClass.updatedAt = Date.now()
        return true
      })
    },
  }
}
