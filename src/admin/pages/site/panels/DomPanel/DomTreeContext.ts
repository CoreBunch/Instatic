/**
 * DomTreeContext — provides the single ExpansionStore instance to the DOM tree.
 *
 * The context value is the stable store object itself (created once in
 * DomTreeProvider via useState lazy init). It never changes reference →
 * zero context-driven re-renders.
 *
 * Per-node expansion state is subscribed via useSyncExternalStore in
 * useIsNodeExpanded so only the toggled row re-renders on a chevron click.
 * This is UI-only state — it is NOT part of the Zustand site store.
 * (Constraint #182: no document-model state outside the store.)
 */
import { createContext, use, useSyncExternalStore } from 'react'
import type { ExpansionStore } from './expansionStore'

export const ExpansionStoreContext = createContext<ExpansionStore | null>(null)

export function useExpansionStore(): ExpansionStore {
  const store = use(ExpansionStoreContext)
  if (!store) throw new Error('useExpansionStore must be used inside DomTreeProvider')
  return store
}

/**
 * Per-node subscription hook — only THIS node re-renders when its expansion flips.
 *
 * getServerSnapshot returns false: expansion is client-only UI state in an
 * admin SPA — there is no SSR path that needs a server snapshot.
 *
 * Hooks must be called unconditionally: call useIsNodeExpanded at the top level
 * of the component and gate the result with isRoot afterward, never conditionally.
 */
export function useIsNodeExpanded(nodeId: string): boolean {
  const store = useExpansionStore()
  return useSyncExternalStore(
    store.subscribe,
    () => store.isExpanded(nodeId),
    () => false,
  )
}
