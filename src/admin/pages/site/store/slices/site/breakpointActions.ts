/**
 * Breakpoint mutation actions: addBreakpoint, updateBreakpoint, removeBreakpoint,
 * reorderBreakpoints.
 */

import { nanoid } from 'nanoid'
import type { Breakpoint } from '@core/page-tree'
import type { SiteSlice, SiteSliceHelpers } from './types'

type BreakpointActions = Pick<
  SiteSlice,
  'addBreakpoint' | 'updateBreakpoint' | 'removeBreakpoint' | 'reorderBreakpoints'
>

export function createBreakpointActions({
  get,
  set,
  mutateSite,
}: SiteSliceHelpers): BreakpointActions {
  return {
    addBreakpoint: (bp) => {
      const newBp: Breakpoint = { ...bp, id: nanoid(8) }
      mutateSite((p) => {
        p.breakpoints.push(newBp)
        return true
      })
      return newBp
    },

    updateBreakpoint: (id, patch) => {
      mutateSite((p) => {
        const idx = p.breakpoints.findIndex((b) => b.id === id)
        if (idx === -1) return false
        const breakpoint = p.breakpoints[idx]
        const changed = Object.entries(patch).some(
          ([key, value]) => !Object.is(breakpoint[key as keyof Omit<Breakpoint, 'id'>], value),
        )
        if (!changed) return false
        Object.assign(breakpoint, patch)
        return true
      })
    },

    removeBreakpoint: (id) => {
      const removed = mutateSite((p) => {
        if (!p.breakpoints.some((b) => b.id === id)) return false
        p.breakpoints = p.breakpoints.filter((b) => b.id !== id)
        return true
      })
      // If the active breakpoint was removed, fall back to desktop
      if (removed && get().activeBreakpointId === id) {
        set((state) => { state.activeBreakpointId = 'desktop' })
      }
    },

    reorderBreakpoints: (fromIndex, toIndex) => {
      mutateSite((p) => {
        if (fromIndex === toIndex) return false
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= p.breakpoints.length ||
          toIndex >= p.breakpoints.length
        ) {
          return false
        }
        const [item] = p.breakpoints.splice(fromIndex, 1)
        p.breakpoints.splice(toIndex, 0, item)
        return true
      })
    },
  }
}
