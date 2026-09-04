/**
 * styleRule slice — create + update of style rules and their per-context
 * style bags: createClass, createAmbientRule, updateClassStyles,
 * setClassContextStyles, plus the exact-selector bulk writers behind the
 * agent/MCP `site_apply_css` tool. Payload algebra lives in rulePayload.ts.
 */

import { nanoid } from 'nanoid'
import type { StyleRule } from '@core/page-tree'
import { classKindSelector } from '@core/page-tree'
import { isGeneratedClassLocked } from '@core/page-tree'
import { assertValidCssClassName } from '@core/page-tree'
import { cssPropertyNameToStorageKey } from '@core/css-substitution'
import { isValidCssSelector } from '../../styleRuleRename'
import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice } from './types'
import { nextRuleOrder, hasStylePatchChanges } from './helpers'
import {
  consolidateIncomingRules,
  rulesBySelector,
  upsertRulesIntoSite,
  type PriorityBag,
} from './rulePayload'

type CrudActions = Pick<
  StyleRuleSlice,
  | 'createClass'
  | 'createAmbientRule'
  | 'updateClassStyles'
  | 'setClassContextStyles'
  | 'applyCssRules'
  | 'deleteCssRules'
  | 'removeCssRuleProperties'
>

const SIDE_STORAGE_KEYS: Record<string, string[]> = {
  padding: ['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  margin: ['margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
}

function storageKeysForProperty(property: string): string[] {
  const storageKey = cssPropertyNameToStorageKey(property)
  return SIDE_STORAGE_KEYS[storageKey] ?? [storageKey]
}

function ruleHasAnyProperty(rule: StyleRule, keys: readonly string[]): boolean {
  if (keys.some((key) => key in rule.styles)) return true
  return Object.values(rule.contextStyles).some((styles) => keys.some((key) => key in styles))
}

function deletePriorityKeys(priorities: PriorityBag | undefined, keys: readonly string[]): void {
  if (!priorities) return
  for (const key of keys) delete priorities[key]
}

export function createCrudActions({ get, mutateSite }: SiteSliceHelpers): CrudActions {
  return {
    createClass(name, styles = {}) {
      const { site } = get()
      if (!site) throw new Error('[styleRuleSlice] Site document is not initialized')
      assertValidCssClassName(name)

      // Uniqueness check
      const existing = Object.values(site.styleRules).find((c) => c.name === name)
      if (existing) throw new Error(`[styleRuleSlice] A class named "${name}" already exists`)

      const now = Date.now()
      const newClass: StyleRule = {
        id: nanoid(),
        name,
        kind: 'class',
        selector: classKindSelector(name),
        order: nextRuleOrder(site.styleRules),
        styles,
        contextStyles: {},
        createdAt: now,
        updatedAt: now,
      }

      mutateSite((site) => {
        site.styleRules[newClass.id] = newClass
        return true
      })

      return newClass
    },

    createAmbientRule(input) {
      const { site } = get()
      if (!site) throw new Error('[styleRuleSlice] Site document is not initialized')

      const selector = input.selector.trim()
      if (selector.length === 0) {
        throw new Error('[styleRuleSlice] Ambient selector cannot be empty')
      }
      if (!isValidCssSelector(selector)) {
        throw new Error(`[styleRuleSlice] Invalid CSS selector: ${selector}`)
      }

      // Default display name to the selector text. Unlike class-kind rules,
      // ambient rule names are not required to be globally unique — multiple
      // rules can share a selector (cascade resolves by `order`).
      const name = (input.name && input.name.trim().length > 0) ? input.name.trim() : selector

      const now = Date.now()
      const newRule: StyleRule = {
        id: nanoid(),
        name,
        kind: 'ambient',
        selector,
        order: nextRuleOrder(site.styleRules),
        styles: input.styles ?? {},
        contextStyles: input.contextStyles ?? {},
        createdAt: now,
        updatedAt: now,
      }

      mutateSite((site) => {
        site.styleRules[newRule.id] = newRule
        return true
      })

      return newRule
    },

    updateClassStyles(classId, patch) {
      const { site } = get()
      const cls = site?.styleRules[classId]
      if (!cls) return
      if (isGeneratedClassLocked(cls)) return
      if (!hasStylePatchChanges(cls.styles, patch)) return

      mutateSite((site) => {
        const draftClass = site.styleRules[classId]
        if (!draftClass) return false
        Object.assign(draftClass.styles, patch)
        // Remove keys explicitly set to undefined/null (allow clearing a property)
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === null) {
            delete draftClass.styles[k]
            delete draftClass.stylePriorities?.[k]
          }
        }
        if (draftClass.stylePriorities && Object.keys(draftClass.stylePriorities).length === 0) {
          delete draftClass.stylePriorities
        }
        draftClass.updatedAt = Date.now()
        return true
      })
    },

    setClassContextStyles(classId, contextId, patch) {
      const { site } = get()
      const cls = site?.styleRules[classId]
      if (!cls) return
      if (isGeneratedClassLocked(cls)) return
      const currentStyles = cls.contextStyles[contextId] ?? {}
      if (!hasStylePatchChanges(currentStyles, patch)) return

      mutateSite((site) => {
        const draftClass = site.styleRules[classId]
        if (!draftClass) return false
        if (!draftClass.contextStyles[contextId]) {
          draftClass.contextStyles[contextId] = {}
        }
        Object.assign(draftClass.contextStyles[contextId], patch)
        // Remove keys explicitly set to undefined/null
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === null) {
            delete draftClass.contextStyles[contextId][k]
            delete draftClass.contextStylePriorities?.[contextId]?.[k]
          }
        }
        const contextPriorities = draftClass.contextStylePriorities?.[contextId]
        if (contextPriorities && Object.keys(contextPriorities).length === 0) {
          delete draftClass.contextStylePriorities?.[contextId]
        }
        if (
          draftClass.contextStylePriorities
          && Object.keys(draftClass.contextStylePriorities).length === 0
        ) {
          delete draftClass.contextStylePriorities
        }
        draftClass.updatedAt = Date.now()
        return true
      })
    },

    applyCssRules(rules, conditions, mode) {
      const { site } = get()
      if (!site) return { created: 0, updated: 0, blockedSelectors: [] }
      const incoming = consolidateIncomingRules(rules)
      const existingBySelector = rulesBySelector(site.styleRules)
      const blockedSelectors = incoming
        .filter(({ selector }) =>
          (existingBySelector.get(selector) ?? []).some(isGeneratedClassLocked),
        )
        .map(({ selector }) => selector)
      if (blockedSelectors.length > 0) {
        return { created: 0, updated: 0, blockedSelectors }
      }

      let created = 0
      let updated = 0
      mutateSite((site) => {
        const conditionsBefore = site.conditions?.length ?? 0
        ;({ created, updated } = upsertRulesIntoSite(site, incoming, conditions, mode, Date.now()))
        return created > 0 || updated > 0 || (site.conditions?.length ?? 0) !== conditionsBefore
      })

      return { created, updated, blockedSelectors: [] }
    },

    deleteCssRules(selectors) {
      const { site } = get()
      if (!site) {
        return { deleted: 0, missingSelectors: selectors, blockedSelectors: [] }
      }
      const requested = [...new Set(selectors.map((selector) => selector.trim()))]
      const existingBySelector = rulesBySelector(site.styleRules)
      const missingSelectors = requested.filter((selector) =>
        (existingBySelector.get(selector) ?? []).length === 0,
      )
      const blockedSelectors = requested.filter((selector) =>
        (existingBySelector.get(selector) ?? []).some(isGeneratedClassLocked),
      )
      if (missingSelectors.length > 0 || blockedSelectors.length > 0) {
        return { deleted: 0, missingSelectors, blockedSelectors }
      }

      const ids = requested.flatMap((selector) =>
        (existingBySelector.get(selector) ?? []).map((rule) => rule.id),
      )
      get().deleteClasses(ids)
      return { deleted: ids.length, missingSelectors: [], blockedSelectors: [] }
    },

    removeCssRuleProperties(selectors, properties) {
      const { site } = get()
      if (!site) {
        return {
          updated: 0,
          removed: 0,
          missingSelectors: selectors,
          missingProperties: properties,
          blockedSelectors: [],
        }
      }
      const requestedSelectors = [...new Set(selectors.map((selector) => selector.trim()))]
      const requestedProperties = [...new Set(properties.map((property) => property.trim()))]
      const existingBySelector = rulesBySelector(site.styleRules)
      const missingSelectors = requestedSelectors.filter((selector) =>
        (existingBySelector.get(selector) ?? []).length === 0,
      )
      const blockedSelectors = requestedSelectors.filter((selector) =>
        (existingBySelector.get(selector) ?? []).some(isGeneratedClassLocked),
      )
      const targets = requestedSelectors.flatMap((selector) => existingBySelector.get(selector) ?? [])
      const propertyKeys = new Map(
        requestedProperties.map((property) => [property, storageKeysForProperty(property)]),
      )
      const missingProperties = requestedProperties.filter((property) =>
        !targets.some((rule) => ruleHasAnyProperty(rule, propertyKeys.get(property) ?? [])),
      )

      if (
        missingSelectors.length > 0
        || blockedSelectors.length > 0
        || missingProperties.length > 0
      ) {
        return {
          updated: 0,
          removed: 0,
          missingSelectors,
          missingProperties,
          blockedSelectors,
        }
      }

      const keys = [...new Set([...propertyKeys.values()].flat())]
      let updated = 0
      let removed = 0
      mutateSite((site) => {
        const now = Date.now()
        for (const target of targets) {
          const draftRule = site.styleRules[target.id]
          if (!draftRule) continue
          let ruleChanged = false
          for (const key of keys) {
            if (key in draftRule.styles) {
              delete draftRule.styles[key]
              removed++
              ruleChanged = true
            }
            for (const contextStyles of Object.values(draftRule.contextStyles)) {
              if (key in contextStyles) {
                delete contextStyles[key]
                removed++
                ruleChanged = true
              }
            }
          }
          deletePriorityKeys(draftRule.stylePriorities, keys)
          if (draftRule.stylePriorities && Object.keys(draftRule.stylePriorities).length === 0) {
            delete draftRule.stylePriorities
          }
          for (const priorities of Object.values(draftRule.contextStylePriorities ?? {})) {
            deletePriorityKeys(priorities, keys)
          }
          if (draftRule.contextStylePriorities) {
            for (const [contextId, priorities] of Object.entries(draftRule.contextStylePriorities)) {
              if (Object.keys(priorities).length === 0) {
                delete draftRule.contextStylePriorities[contextId]
              }
            }
            if (Object.keys(draftRule.contextStylePriorities).length === 0) {
              delete draftRule.contextStylePriorities
            }
          }
          if (!ruleChanged) continue
          draftRule.updatedAt = now
          updated++
        }
        return updated > 0
      })

      return {
        updated,
        removed,
        missingSelectors: [],
        missingProperties: [],
        blockedSelectors: [],
      }
    },
  }
}
