/**
 * styleRule slice — node ↔ class assignment: addNodeClass, addNodeClasses,
 * setNodeClassAssignments, removeNodeClass, reorderNodeClasses,
 * reorderNodeClass.
 *
 * Invariant: `node.classIds` only ever holds class-kind rule ids. Ambient
 * rules attach by selector matching, not by class-attribute assignment, so
 * assignment actions refuse them (and log) rather than leak a
 * never-matching token into the rendered `class=` attribute.
 */

import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice } from './types'
import { findNodeWithClassIds, mutateNodeClassIds } from './helpers'

type AssignmentActions = Pick<
  StyleRuleSlice,
  | 'addNodeClass'
  | 'addNodeClasses'
  | 'setNodeClassAssignments'
  | 'removeNodeClass'
  | 'reorderNodeClasses'
  | 'reorderNodeClass'
>

export function createAssignmentActions({ get, mutateSiteState }: SiteSliceHelpers): AssignmentActions {
  function updateNodeClassAssignments(
    nodeIds: string[],
    classId: string,
    assigned: boolean,
  ): void {
    const { site } = get()
    const uniqueNodeIds = [...new Set(nodeIds)]
    if (!site || uniqueNodeIds.length === 0) return

    // `kind` was added after the original class registry, so an absent kind
    // remains a normal class. Ambient rules are selector-attached and must
    // never enter a node's classIds array.
    const cls = site.styleRules[classId]
    if (cls && cls.kind && cls.kind !== 'class') {
      console.error(
        '[styleRuleSlice] setNodeClassAssignments refused: classId references an ambient rule',
        { nodeIds: uniqueNodeIds, classId, selector: cls.selector },
      )
      return
    }

    mutateSiteState((state) => {
      let changed = false
      for (const nodeId of uniqueNodeIds) {
        mutateNodeClassIds(state, nodeId, (classIds) => {
          if (assigned) {
            if (classIds.includes(classId)) return
            classIds.push(classId)
            changed = true
            return
          }

          const index = classIds.indexOf(classId)
          if (index === -1) return
          classIds.splice(index, 1)
          changed = true
        })
      }
      return changed
    })
  }

  return {
    addNodeClass(nodeId, classId) {
      updateNodeClassAssignments([nodeId], classId, true)
    },

    addNodeClasses(nodeId, classIds) {
      const { site } = get()
      const node = findNodeWithClassIds(site, nodeId)
      if (!node) return
      // Keep only class-kind rules the node doesn't already have. Ambient rules
      // attach by selector matching, not by class attribute, so they're skipped
      // (same invariant as addNodeClass).
      const toAdd = classIds.filter((classId) => {
        if (node.classIds?.includes(classId)) return false
        const cls = site?.styleRules[classId]
        if (cls && cls.kind && cls.kind !== 'class') {
          console.error(
            '[styleRuleSlice] addNodeClasses skipped an ambient rule',
            { nodeId, classId, selector: cls.selector },
          )
          return false
        }
        return true
      })
      if (toAdd.length === 0) return

      mutateSiteState((state) => {
        const mutated = mutateNodeClassIds(state, nodeId, (existing) => {
          for (const id of toAdd) {
            if (!existing.includes(id)) existing.push(id)
          }
        })
        return mutated
      })
    },

    setNodeClassAssignments(nodeIds, classId, assigned) {
      updateNodeClassAssignments(nodeIds, classId, assigned)
    },

    removeNodeClass(nodeId, classId) {
      updateNodeClassAssignments([nodeId], classId, false)
    },

    reorderNodeClasses(nodeId, fromIndex, toIndex) {
      const { site } = get()
      if (!site) return
      if (fromIndex === toIndex) return
      if (fromIndex < 0 || toIndex < 0) return
      const node = findNodeWithClassIds(site, nodeId)
      const classIds = node?.classIds
      if (!classIds || classIds.length <= Math.max(fromIndex, toIndex)) return

      mutateSiteState((state) => {
        let moved = false
        const mutated = mutateNodeClassIds(state, nodeId, (arr) => {
          if (arr.length <= Math.max(fromIndex, toIndex)) return
          const [item] = arr.splice(fromIndex, 1)
          arr.splice(toIndex, 0, item)
          moved = true
        })
        return mutated && moved
      })
    },

    reorderNodeClass(nodeId, classId, direction) {
      const { site } = get()
      if (!site) return
      const node = findNodeWithClassIds(site, nodeId)
      const classIds = node?.classIds
      if (!classIds || classIds.length < 2) return
      const idx = classIds.indexOf(classId)
      if (idx === -1) return
      const newIdx = direction === 'up' ? idx - 1 : idx + 1
      // No-op at array boundaries — Guideline #242
      if (newIdx < 0 || newIdx >= classIds.length) return

      mutateSiteState((state) => {
        let moved = false
        const mutated = mutateNodeClassIds(state, nodeId, (arr) => {
          const i = arr.indexOf(classId)
          if (i === -1) return
          const target = direction === 'up' ? i - 1 : i + 1
          if (target < 0 || target >= arr.length) return
          const [item] = arr.splice(i, 1)
          arr.splice(target, 0, item)
          moved = true
        })
        return mutated && moved
      })
    },
  }
}
