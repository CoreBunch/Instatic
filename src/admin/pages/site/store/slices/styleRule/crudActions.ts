/**
 * styleRule slice — create + update of style rules and their per-context
 * style bags: createClass, createAmbientRule, updateClassStyles,
 * setClassContextStyles.
 */

import { nanoid } from 'nanoid'
import type { StyleRule } from '@core/page-tree'
import { classKindSelector } from '@core/page-tree'
import { isGeneratedClassLocked } from '@core/page-tree'
import { assertValidCssClassName } from '@core/page-tree'
import { styleRuleSelector } from '@core/page-tree'
import { cssPropertyNameToStorageKey } from '@core/css-substitution'
import type { NewStyleRule } from '@core/siteImport'
import { isValidCssSelector } from '../../styleRuleRename'
import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice } from './types'
import { nextRuleOrder, hasStylePatchChanges } from './helpers'

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

type PriorityBag = Record<string, 'important'>

interface RulePayload {
  styles: Record<string, unknown>
  contextStyles: Record<string, Record<string, unknown>>
  stylePriorities?: PriorityBag
  contextStylePriorities?: Record<string, PriorityBag>
  rawCss?: string
}

function clonePriorityBag(priorities: PriorityBag | undefined): PriorityBag | undefined {
  if (!priorities || Object.keys(priorities).length === 0) return undefined
  return { ...priorities }
}

function cloneContextStyles(
  contexts: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(contexts ?? {}).map(([contextId, styles]) => [contextId, { ...styles }]),
  )
}

function cloneContextPriorities(
  contexts: Record<string, PriorityBag> | undefined,
): Record<string, PriorityBag> | undefined {
  if (!contexts) return undefined
  const cloned = Object.fromEntries(
    Object.entries(contexts)
      .filter(([, priorities]) => Object.keys(priorities).length > 0)
      .map(([contextId, priorities]) => [contextId, { ...priorities }]),
  )
  return Object.keys(cloned).length > 0 ? cloned : undefined
}

function payloadFromRule(rule: StyleRule | NewStyleRule): RulePayload {
  return {
    styles: { ...rule.styles },
    contextStyles: cloneContextStyles(rule.contextStyles),
    stylePriorities: clonePriorityBag(rule.stylePriorities),
    contextStylePriorities: cloneContextPriorities(rule.contextStylePriorities),
    ...(rule.rawCss !== undefined ? { rawCss: rule.rawCss } : {}),
  }
}

function orderedBagEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([key, value], index) => {
    const rightEntry = rightEntries[index]
    return rightEntry?.[0] === key && Object.is(rightEntry[1], value)
  })
}

function priorityBagEqual(left: PriorityBag | undefined, right: PriorityBag | undefined): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightEntries = Object.entries(right ?? {})
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([key, value]) => right?.[key] === value)
}

function contextStylesEqual(
  left: Record<string, Record<string, unknown>>,
  right: Record<string, Record<string, unknown>>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((contextId) => {
    const rightBag = right[contextId]
    return rightBag !== undefined && orderedBagEqual(left[contextId], rightBag)
  })
}

function contextPrioritiesEqual(
  left: Record<string, PriorityBag> | undefined,
  right: Record<string, PriorityBag> | undefined,
): boolean {
  const leftContexts = left ?? {}
  const rightContexts = right ?? {}
  const leftKeys = Object.keys(leftContexts)
  const rightKeys = Object.keys(rightContexts)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((contextId) => priorityBagEqual(leftContexts[contextId], rightContexts[contextId]))
}

function payloadEqual(left: RulePayload, right: RulePayload): boolean {
  return orderedBagEqual(left.styles, right.styles)
    && contextStylesEqual(left.contextStyles, right.contextStyles)
    && priorityBagEqual(left.stylePriorities, right.stylePriorities)
    && contextPrioritiesEqual(left.contextStylePriorities, right.contextStylePriorities)
    && Object.is(left.rawCss, right.rawCss)
}

/**
 * Merge one declaration layer while moving every touched declaration to the
 * end in the incoming authored order. Object.assign keeps an existing key in
 * its old position, which can leave a longhand before a later shorthand and
 * make an apparently successful CSS repair lose in the emitted rule.
 */
function mergeLayer(
  current: Record<string, unknown>,
  currentPriorities: PriorityBag | undefined,
  patch: Record<string, unknown>,
  patchPriorities: PriorityBag | undefined,
  respectExistingImportant: boolean,
): { styles: Record<string, unknown>; priorities?: PriorityBag } {
  const acceptedPatchKeys = new Set<string>()
  for (const key of Object.keys(patch)) {
    if (
      respectExistingImportant
      && currentPriorities?.[key] === 'important'
      && patchPriorities?.[key] !== 'important'
    ) {
      continue
    }
    acceptedPatchKeys.add(key)
  }

  const styles: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(current)) {
    if (!acceptedPatchKeys.has(key)) styles[key] = value
  }
  for (const [key, value] of Object.entries(patch)) {
    if (acceptedPatchKeys.has(key)) styles[key] = value
  }

  const priorities: PriorityBag = {}
  for (const [key, priority] of Object.entries(currentPriorities ?? {})) {
    if (!acceptedPatchKeys.has(key)) priorities[key] = priority
  }
  for (const key of acceptedPatchKeys) {
    if (patchPriorities?.[key] === 'important') priorities[key] = 'important'
  }

  return {
    styles,
    ...(Object.keys(priorities).length > 0 ? { priorities } : {}),
  }
}

function mergePayload(
  current: RulePayload,
  patch: RulePayload,
  respectExistingImportant: boolean,
): RulePayload {
  const base = mergeLayer(
    current.styles,
    current.stylePriorities,
    patch.styles,
    patch.stylePriorities,
    respectExistingImportant,
  )
  const contextStyles = cloneContextStyles(current.contextStyles)
  const contextStylePriorities = cloneContextPriorities(current.contextStylePriorities) ?? {}

  for (const [contextId, patchStyles] of Object.entries(patch.contextStyles)) {
    const merged = mergeLayer(
      contextStyles[contextId] ?? {},
      contextStylePriorities[contextId],
      patchStyles,
      patch.contextStylePriorities?.[contextId],
      respectExistingImportant,
    )
    contextStyles[contextId] = merged.styles
    if (merged.priorities) contextStylePriorities[contextId] = merged.priorities
    else delete contextStylePriorities[contextId]
  }

  return {
    styles: base.styles,
    contextStyles,
    ...(base.priorities ? { stylePriorities: base.priorities } : {}),
    ...(Object.keys(contextStylePriorities).length > 0 ? { contextStylePriorities } : {}),
    ...(patch.rawCss !== undefined
      ? { rawCss: patch.rawCss }
      : current.rawCss !== undefined
        ? { rawCss: current.rawCss }
        : {}),
  }
}

function writePayload(target: StyleRule, payload: RulePayload): void {
  target.styles = payload.styles
  target.contextStyles = payload.contextStyles
  if (payload.stylePriorities) target.stylePriorities = payload.stylePriorities
  else delete target.stylePriorities
  if (payload.contextStylePriorities) {
    target.contextStylePriorities = payload.contextStylePriorities
  } else {
    delete target.contextStylePriorities
  }
  if (payload.rawCss !== undefined) target.rawCss = payload.rawCss
  else delete target.rawCss
}

interface ConsolidatedRule {
  selector: string
  source: NewStyleRule
  payload: RulePayload
}

function consolidateIncomingRules(rules: NewStyleRule[]): ConsolidatedRule[] {
  const bySelector = new Map<string, ConsolidatedRule>()
  for (const rule of rules) {
    const selector = styleRuleSelector(rule)
    const existing = bySelector.get(selector)
    if (!existing) {
      const item = { selector, source: rule, payload: payloadFromRule(rule) }
      bySelector.set(selector, item)
      continue
    }
    // Multiple authored blocks with the same selector collapse exactly as the
    // CSS cascade would: a prior important value beats a later normal one;
    // otherwise the later declaration wins and moves to the end.
    existing.payload = mergePayload(existing.payload, payloadFromRule(rule), true)
  }
  return [...bySelector.values()]
}

function rulesBySelector(rules: Record<string, StyleRule>): Map<string, StyleRule[]> {
  const index = new Map<string, StyleRule[]>()
  for (const rule of Object.values(rules)) {
    const selector = styleRuleSelector(rule)
    const matches = index.get(selector)
    if (matches) matches.push(rule)
    else index.set(selector, [rule])
  }
  return index
}

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
        let mutated = false

        // Register referenced reusable conditions before their context bags.
        if (conditions.length > 0) {
          if (!site.conditions) site.conditions = []
          const known = new Set(site.conditions.map((c) => c.id))
          for (const def of conditions) {
            if (known.has(def.id)) continue
            known.add(def.id)
            site.conditions.push(def)
            mutated = true
          }
        }

        const targetBySelector = rulesBySelector(site.styleRules)
        let maxOrder = -1
        for (const rule of Object.values(site.styleRules)) {
          if (typeof rule.order === 'number' && rule.order > maxOrder) maxOrder = rule.order
        }

        const now = Date.now()
        for (const item of incoming) {
          const targets = targetBySelector.get(item.selector) ?? []
          if (targets.length > 0) {
            for (const target of targets) {
              const current = payloadFromRule(target)
              const next = mode === 'replace'
                ? item.payload
                : mergePayload(current, item.payload, false)
              if (payloadEqual(current, next)) continue
              writePayload(target, next)
              target.updatedAt = now
              updated++
              mutated = true
            }
            continue
          }

          const id = nanoid()
          const newRule: StyleRule = {
            ...item.source,
            ...item.payload,
            id,
            order: (maxOrder += 1),
            createdAt: now,
            updatedAt: now,
          }
          site.styleRules[id] = newRule
          targetBySelector.set(item.selector, [newRule])
          created++
          mutated = true
        }

        return mutated
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
