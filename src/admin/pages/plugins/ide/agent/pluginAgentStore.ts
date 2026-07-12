/**
 * Plugin-IDE agent store — a small standalone Zustand instance holding ONLY
 * the AgentSlice, composed per PluginIdeAgentMount. Same shape and
 * rationale as the content workspace's `contentAgentStore.ts`: the IDE is
 * hook-based (no parent Zustand store), and a per-mount instance keeps
 * stale closures from surviving navigation.
 *
 * The `as unknown as ...` cast bridges the slice's site-editor-shaped
 * return type into our slice-only store — the slice only touches AgentSlice
 * keys at runtime (see contentAgentStore.ts for the full justification).
 */
import { create, type StateCreator } from 'zustand'
import { mutative } from 'zustand-mutative'
import { subscribeWithSelector } from 'zustand/middleware'
import { createAgentSlice, type AgentSlice } from '@site/agent'
import { pluginAgentSliceConfig } from './agentSliceConfig.plugin'

type PluginAgentStore = AgentSlice

export function createPluginAgentStore() {
  const sliceCreator = createAgentSlice(pluginAgentSliceConfig) as unknown as
    StateCreator<AgentSlice, [['zustand/mutative', never]], [], AgentSlice>
  return create<PluginAgentStore>()(
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
