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
  | 'upsertCssRules'
>

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
          }
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
          }
        }
        draftClass.updatedAt = Date.now()
        return true
      })
    },

    upsertCssRules(rules, conditions) {
      const { site } = get()
      if (!site) return { created: 0, updated: 0 }
      let created = 0
      let updated = 0

      mutateSite((site) => {
        // 1. Register any referenced reusable conditions (custom @media /
        //    @container / @supports) so per-context overrides resolve, deduped
        //    by deterministic id.
        if (conditions.length > 0) {
          if (!site.conditions) site.conditions = []
          const known = new Set(site.conditions.map((c) => c.id))
          for (const def of conditions) {
            if (known.has(def.id)) continue
            known.add(def.id)
            site.conditions.push(def)
          }
        }

        // 2. Index the live registry so an incoming rule UPDATES the rule it
        //    names instead of piling up a duplicate: class rules key on `name`,
        //    ambient rules key on `selector` (first id wins on the rare clash).
        const classByName = new Map<string, string>()
        const ambientBySelector = new Map<string, string>()
        let maxOrder = -1
        for (const rule of Object.values(site.styleRules)) {
          if (typeof rule.order === 'number' && rule.order > maxOrder) maxOrder = rule.order
          if (rule.kind === 'ambient') {
            if (!ambientBySelector.has(rule.selector)) ambientBySelector.set(rule.selector, rule.id)
          } else if (!classByName.has(rule.name)) {
            classByName.set(rule.name, rule.id)
          }
        }

        // 3. Upsert: merge onto the matching rule, or mint a new one at the end
        //    of the cascade. This is the whole point of the tool — re-applying
        //    `.hero a { color: blue }` over an existing `.hero a` EDITS it,
        //    where the additive import path would have skipped it as a dupe.
        const now = Date.now()
        for (const rule of rules) {
          const existingId = rule.kind === 'ambient'
            ? ambientBySelector.get(rule.selector)
            : classByName.get(rule.name)

          if (existingId) {
            const target = site.styleRules[existingId]
            // Never overwrite a framework-generated token/utility class — those
            // are owned by the design system, not authored CSS.
            if (isGeneratedClassLocked(target)) continue
            Object.assign(target.styles, rule.styles)
            for (const [contextId, patch] of Object.entries(rule.contextStyles ?? {})) {
              if (!target.contextStyles[contextId]) target.contextStyles[contextId] = {}
              Object.assign(target.contextStyles[contextId], patch)
            }
            target.updatedAt = now
            updated++
          } else {
            const id = nanoid()
            site.styleRules[id] = {
              ...rule,
              id,
              order: (maxOrder += 1),
              createdAt: now,
              updatedAt: now,
            }
            if (rule.kind === 'ambient') ambientBySelector.set(rule.selector, id)
            else classByName.set(rule.name, id)
            created++
          }
        }

        return created > 0 || updated > 0
      })

      return { created, updated }
    },
  }
}
