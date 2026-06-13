/**
 * styleRule slice — transient editor UI state: which class the Class Composer
 * edits, inline-style editing mode, and the two canvas hover previews.
 *
 * These fields live on editor state (not the SiteDocument), so they are set
 * via the raw `set` helper and never push undo history.
 *
 * Guideline #242 — no-op guard: every setter bails out when the new value
 * equals the current value to prevent re-render loops.
 */

import type { SiteSliceHelpers } from '../site/types'
import type { StyleRuleSlice } from './types'
import { shallowEqualStyles } from './helpers'

type UiStateActions = Pick<
  StyleRuleSlice,
  | 'setActiveClass'
  | 'setInlineStyleEditing'
  | 'setPreviewNodeClass'
  | 'clearPreviewNodeClass'
  | 'setPreviewClassStyles'
  | 'clearPreviewClassStyles'
>

export function createUiStateActions({ set, get }: SiteSliceHelpers): UiStateActions {
  return {
    setActiveClass(id) {
      const { activeClassId, inlineStyleEditing } = get()
      // Selecting a real class always switches away from inline editing.
      const nextInline = id !== null ? false : inlineStyleEditing
      // Guideline #242 no-op guard — bail only when nothing actually changes.
      if (Object.is(activeClassId, id) && nextInline === inlineStyleEditing) return
      set((s) => {
        s.activeClassId = id
        s.inlineStyleEditing = nextInline
      })
    },

    setInlineStyleEditing(active) {
      if (get().inlineStyleEditing === active) return
      // Enabling inline editing clears the active class so the two targets stay
      // mutually exclusive; disabling leaves the active class untouched.
      set((s) => {
        s.inlineStyleEditing = active
        if (active) s.activeClassId = null
      })
    },

    setPreviewNodeClass(nodeId, classId) {
      const current = get().previewClassAssignment
      if (current?.nodeId === nodeId && current.classId === classId) return
      set((s) => {
        s.previewClassAssignment = { nodeId, classId }
      })
    },

    clearPreviewNodeClass(nodeId, classId) {
      const current = get().previewClassAssignment
      if (!current) return
      if (nodeId !== undefined && current.nodeId !== nodeId) return
      if (classId !== undefined && current.classId !== classId) return
      set((s) => {
        s.previewClassAssignment = null
      })
    },

    setPreviewClassStyles(preview) {
      const current = get().previewClassStyles
      if (
        current &&
        current.classId === preview.classId &&
        (current.breakpointId ?? null) === (preview.breakpointId ?? null) &&
        shallowEqualStyles(current.styles, preview.styles)
      ) {
        return
      }
      set((s) => {
        s.previewClassStyles = preview
      })
    },

    clearPreviewClassStyles(classId) {
      const current = get().previewClassStyles
      if (!current) return
      if (classId !== undefined && current.classId !== classId) return
      set((s) => {
        s.previewClassStyles = null
      })
    },
  }
}
