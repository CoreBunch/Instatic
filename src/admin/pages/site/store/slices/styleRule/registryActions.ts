/**
 * styleRule slice — registry lifecycle: ensureNodeStyleClass, renameClass,
 * duplicateClass(es), deleteClass(es). These create, clone, rename, or remove
 * entries in `site.styleRules` and keep node/VC `classIds` references in sync.
 */

import { nanoid } from 'nanoid'
import type { StyleRule } from '@core/page-tree'
import { classKindSelector } from '@core/page-tree'
import { isGeneratedClassLocked, isUserVisibleClass } from '@core/page-tree'
import { renameStyleRule } from '../../styleRuleRename'
import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice } from './types'
import {
  nextRuleOrder,
  cloneContextStyles,
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
        return cls?.scope?.type === 'node' && cls.scope.nodeId === nodeId && cls.scope.role === 'module-style'
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
      // Duplicating preserves the source rule's kind and selector pattern. For
      // class-kind rules the selector is rebuilt from the new (unique) name; for
      // ambient rules the selector text is copied verbatim so the rule still
      // matches the same elements after duplication.
      const kind = cls.kind ?? 'class'
      const selector = kind === 'class' ? classKindSelector(copyName) : (cls.selector || classKindSelector(copyName))
      const newClass: StyleRule = {
        id: nanoid(),
        name: copyName,
        kind,
        selector,
        order: nextRuleOrder(site.styleRules),
        description: cls.description,
        styles: { ...cls.styles },
        // Per-context overrides reference the shared site-level conditions
        // registry by id, so cloning the bags (independent copies) is enough —
        // no per-rule condition definitions to clone.
        contextStyles: cloneContextStyles(cls.contextStyles),
        tags: cls.tags ? [...cls.tags] : undefined,
        createdAt: now,
        updatedAt: now,
      }

      mutateSite((site) => {
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
          // Remove from every node on every page AND every Visual Component
          // tree — class IDs are global, so a deleted class must disappear
          // from both surfaces or a VC keeps a dangling reference.
          for (const page of site.pages) {
            for (const node of Object.values(page.nodes)) {
              if (node.classIds && node.classIds.includes(classId)) {
                node.classIds = node.classIds.filter((id) => id !== classId)
              }
            }
          }
          for (const vc of site.visualComponents) {
            for (const node of Object.values(vc.tree.nodes)) {
              if (node.classIds && node.classIds.includes(classId)) {
                node.classIds = node.classIds.filter((id) => id !== classId)
              }
            }
          }
        }
        if (!mutated) return false
        // Clear active / selected references that pointed at a deleted class.
        if (state.activeClassId && targets.has(state.activeClassId)) {
          state.activeClassId = null
        }
        if (state.selectedSelectorClassId && targets.has(state.selectedSelectorClassId)) {
          state.selectedSelectorClassId = null
        }
        if (state.selectedSelectorClassIds.length > 0) {
          state.selectedSelectorClassIds = state.selectedSelectorClassIds.filter(
            (id) => !targets.has(id),
          )
        }
        return true
      })
    },
  }
}
