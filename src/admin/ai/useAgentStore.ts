/**
 * Hook half of the AgentStoreContext pair — see `./AgentStoreContext.tsx`.
 *
 * Sits in its own file so React Fast Refresh's "components-only" rule on
 * the .tsx file holds (the context provider is the only export there).
 */
import { createContext, useContext } from 'react'
import { useStore as useZustandStore } from 'zustand'
import type { AgentSlice } from '@site/agent'

/**
 * Zustand store API the AgentStoreProvider accepts. The store's state
 * must extend `AgentSlice`; consumers read through selector functions so
 * the wider state shape doesn't leak into the panel components.
 *
 * Typed loosely as a structural shape (subscribe + getState + setState)
 * rather than `StoreApi<AgentSlice>` so the type accepts any Zustand
 * store whose state includes AgentSlice — including stores wrapped in
 * middleware (subscribeWithSelector, zustand-mutative) whose `setState` signature
 * widens to accept the combined store shape.
 */
export interface AgentStoreApi {
  getState(): AgentSlice
  getInitialState(): AgentSlice
  setState(
    partial:
      | Partial<AgentSlice>
      | ((state: AgentSlice) => AgentSlice | Partial<AgentSlice>),
    replace?: false,
  ): void
  subscribe(listener: (state: AgentSlice, prevState: AgentSlice) => void): () => void
}

/**
 * Context value — the raw Zustand store API. `useAgentStore` calls
 * `useStore(api, selector)` to subscribe; this avoids the React-Compiler
 * "hooks cannot be passed as values" rule that the alternative pattern
 * (passing the host's hook function around) tripped.
 */
export const AgentStoreContext = createContext<AgentStoreApi | null>(null)

/**
 * Read agent state from the host store. Throws when called outside an
 * AgentStoreProvider — the panel components rely on a host being
 * mounted; an unprovided render is a wiring bug, not a missing-data case.
 */
export function useAgentStore<U>(selector: (slice: AgentSlice) => U): U {
  const api = useContext(AgentStoreContext)
  if (!api) {
    throw new Error(
      '[AgentStoreContext] No AgentStoreProvider in tree. ' +
      'Wrap the AgentPanel mount in <AgentStoreProvider store={...}>.',
    )
  }
  return useZustandStore(api, selector)
}
