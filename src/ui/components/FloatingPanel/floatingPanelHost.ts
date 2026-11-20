/**
 * Drill-in host contract between a FloatingPanel and the controls inside it.
 *
 * Separated from FloatingPanel.tsx because the context object and hook are
 * not component exports (react-refresh/only-export-components rule).
 */

import { createContext } from 'react'

/** A drilled-in view: contextual header title + how to get back. */
export interface FloatingPanelDrill {
  anchor: HTMLElement | null
  title: string
  onBack: () => void
}

export interface FloatingPanelHost {
  /** Register a drill view; the returned cleanup restores the main view. */
  registerDrill: (drill: FloatingPanelDrill) => () => void
  /** Where the drilled view portals to; stays mounted for the lifetime of the panel. */
  drillContainer: HTMLElement | null
}

export const FloatingPanelHostContext = createContext<FloatingPanelHost | null>(null)
