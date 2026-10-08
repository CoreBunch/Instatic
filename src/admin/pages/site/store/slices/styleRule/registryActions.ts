/**
 * styleRule slice — registry lifecycle: ensureNodeStyleClass, renameClass,
 * duplicateClass(es), deleteClass(es). These create, clone, rename, or remove
 * entries in `site.styleRules` and keep node/VC `classIds` references in sync.
 */

import { nanoid } from 'nanoid'
import { Value } from '@core/utils/typeboxHelpers'
import type { StyleRule } from '@core/page-tree'
import {
  classKindSelector,
  replaceCssSelectorClassName,
  selectorBindingClassName,
} from '@core/page-tree'
import { isGeneratedClassLocked, isUserVisibleClass } from '@core/page-tree'
import { renameStyleRule } from '../../styleRuleRename'
import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice } from './types'
import {
  nextRuleOrder,
  ruleOrderAfter,
  removeStyleRuleReferences,
  uniqueClassCopyName,
  findNodeWithClassIds,
  mutateNodeClassIds,
} from './helpers'

type RegistryActions = Pick<
  StyleRuleSlice,
  | 'ensureNodeStyleClass'
  | 'renameClass'
  | 'duplicateClass'
  | 'duplicateClasses'
  | 'deleteClass'
  | 'deleteClasses'
>

export function createRegistryActions({
  get,
  mutateSite,
  mutateSiteState,
}: SiteSliceHelpers): RegistryActions {
  return {
    ensureNodeStyleClass(nodeId, moduleName = 'Module') {
      const { site } = get()
      if (!site) return null

      const node = findNodeWithClassIds(site, nodeId)
      if (!node) return null

      const existingId = node.classIds?.find((id) => {
        const cls = site.styleRules[id]
        return (
          cls?.scope?.type === 'node' &&
          cls.scope.nodeId === nodeId &&
          cls.scope.role === 'module-style'
        )
      })
      if (existingId && site.styleRules[existingId]) {
        return site.styleRules[existingId]
      }

      const now = Date.now()
      const instanceName = `${moduleName} instance ${nodeId.slice(0, 6)}`
      const newClass: StyleRule = {
        id: nanoid(),
        name: instanceName,
        kind: 'class',
        selector: classKindSelector(instanceName),
        order: nextRuleOrder(site.styleRules),
        description: 'Node-scoped module style layer',
        scope: { type: 'node', nodeId, role: 'module-style' },
        styles: {},
        contextStyles: {},
        tags: ['module-instance'],
        createdAt: now,
        updatedAt: now,
      }

      mutateSiteState((state, site) => {
        const mutated = mutateNodeClassIds(state, nodeId, (classIds) => {
          // Drop any prior module-style class scoped to this node before
          // appending the freshly created one. The filter is in-place via
          // splice so we don't reassign `node.classIds` inside the recipe.
          for (let i = classIds.length - 1; i >= 0; i--) {
            const cls = site.styleRules[classIds[i]]
            if (
              cls?.scope?.type === 'node' &&
              cls.scope.nodeId === nodeId &&
              cls.scope.role === 'module-style'
            ) {
              classIds.splice(i, 1)
            }
          }
          classIds.push(newClass.id)
        })
        if (!mutated) return false
        site.styleRules[newClass.id] = newClass
        return true
      })

      return newClass
    },

    renameClass(classId, name) {
      const { site } = get()
      if (!site?.styleRules[classId]) return
      mutateSite((site) => renameStyleRule(site.styleRules, classId, name))
    },

    duplicateClass(classId) {
      const { site } = get()
      const cls = site?.styleRules[classId]
      if (!site || !cls || !isUserVisibleClass(cls)) return null
      if (isGeneratedClassLocked(cls)) return null

      const now = Date.now()
      const copyName = uniqueClassCopyName(site.styleRules, cls.name)
      const kind = cls.kind
      const escapedName = classKindSelector(copyName).slice(1)
      const selector =
        kind === 'class'
          ? replaceCssSelectorClassName(cls.selector, cls.name, escapedName)
          : cls.selector
      const newClass: StyleRule = {
        ...Value.Clone(cls),
        id: nanoid(),
        name: copyName,
        kind,
        selector,
        order: ruleOrderAfter(site.styleRules, cls),
        createdAt: now,
        updatedAt: now,
      }
      // A user-created copy is independent from import replacement and
      // framework regeneration, while its native CSS metadata is retained.
      delete newClass.origin
      delete newClass.generated

      mutateSite((site) => {
        if (kind === 'class') {
          // A class may span several authored fragments. Copy every rule with
          // that styled subject at its source position, including its nested
          // contexts, so anonymous layer occurrences remain one block.
          const fragments = Object.values(site.styleRules).filter(
            (rule) =>
              rule.id !== cls.id &&
              !rule.atRule &&
              !rule.rawCss &&
              selectorBindingClassName(rule.selector) === cls.name,
          )
          for (const fragment of fragments) {
            const copy = Value.Clone(fragment)
            copy.id = nanoid()
            copy.kind = 'ambient'
            copy.selector = replaceCssSelectorClassName(fragment.selector, cls.name, escapedName)
            copy.name = fragment.name === cls.name ? copyName : copy.selector
            copy.order = ruleOrderAfter(site.styleRules, fragment)
            copy.createdAt = now
            copy.updatedAt = now
            delete copy.origin
            delete copy.generated
            site.styleRules[copy.id] = copy
          }
        }
        site.styleRules[newClass.id] = newClass
        return true
      })

      return newClass
    },

    duplicateClasses(classIds) {
      // Each duplicateClass() call re-reads the live registry, so cloning one at a
      // time keeps copy-name uniqueness correct across the whole batch.
      const copies: StyleRule[] = []
      for (const classId of classIds) {
        const copy = get().duplicateClass(classId)
        if (copy) copies.push(copy)
      }
      return copies
    },

    deleteClass(classId) {
      get().deleteClasses([classId])
    },

    deleteClasses(classIds) {
      const { site } = get()
      if (!site) return
      // Resolve the deletable set up front: existing, non-locked classes only.
      const targets = new Set(
        classIds.filter((id) => {
          const cls = site.styleRules[id]
          return cls && !isGeneratedClassLocked(cls)
        }),
      )
      if (targets.size === 0) return

      mutateSiteState((state, site) => {
        let mutated = false
        for (const classId of targets) {
          if (!site.styleRules[classId]) continue
          // Remove from registry
          delete site.styleRules[classId]
          mutated = true
        }
        if (!mutated) return false
        removeStyleRuleReferences(state, site, targets)
        return true
      })
    },
  }
}
