/**
 * A standalone Zustand store holding ONLY the AgentSlice — the shape the
 * hook-based workspaces (Content, Plugin IDE) compose per page mount.
 *
 * Why standalone: those workspaces are built on React hooks, not Zustand,
 * so there is no parent store to compose the slice into, and building a
 * whole workspace store just for the agent would be overkill.
 *
 * Why per mount (not module-level like useEditorStore): the pages mount and
 * unmount as the user navigates; rebuilding the store each mount keeps
 * memory in check and makes sure stale snapshot closures do not survive a
 * logout or user swap. The site editor's store is module-level because the
 * editor session is the entire admin lifetime, which does not apply here.
 *
 * The `as unknown as …` cast bridges the slice factory's site-editor-shaped
 * return type (`EditorStoreSliceCreator<AgentSlice>`, typed for the combined
 * site store) into a slice-only store. The slice only ever touches
 * AgentSlice keys at runtime, so the widening is structurally safe and
 * beats duplicating the factory per store shape.
 */
import { create, type StateCreator } from 'zustand'
import { mutative } from 'zustand-mutative'
import { subscribeWithSelector } from 'zustand/middleware'
import { createAgentSlice, type AgentSlice, type AgentSliceConfig } from '@site/agent'

export function createScopedAgentStore(config: AgentSliceConfig) {
  const sliceCreator = createAgentSlice(config) as unknown as StateCreator<
    AgentSlice,
    [['zustand/mutative', never]],
    [],
    AgentSlice
  >
  return create<AgentSlice>()(
    subscribeWithSelector(
      mutative(
        (...args) => ({
          ...sliceCreator(...args),
        }),
        { enableAutoFreeze: true },
      ),
    ),
  )
}
