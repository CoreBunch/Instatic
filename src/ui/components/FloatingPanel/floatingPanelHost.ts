/**
 * Drill-in host contract between a FloatingPanel and the controls inside it.
 *
 * Separated from FloatingPanel.tsx because the context object and hook are
 * not component exports (react-refresh/only-export-components rule).
 */

import { createContext, useContext } from 'react'

/** A drilled-in view: contextual header title + how to get back. */
export interface FloatingPanelDrill {
  title: string
  onBack: () => void
}

export interface FloatingPanelHost {
  /** Register a drill view; the returned cleanup restores the main view. */
  registerDrill: (drill: FloatingPanelDrill) => () => void
  /** Where the drilled view portals to; exists only while a drill is active. */
  drillContainer: HTMLElement | null
}

export const FloatingPanelHostContext = createContext<FloatingPanelHost | null>(null)

/**
 * Whether the calling component renders inside a FloatingPanel — i.e. whether
 * `FloatingPanelDrillView` has a panel to drill into. Controls like ColorInput
 * use it to pick between drilling in and opening their own panel.
 */
export function useHasFloatingPanelHost(): boolean {
  return useContext(FloatingPanelHostContext) !== null
}
