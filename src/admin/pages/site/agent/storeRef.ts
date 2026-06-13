/**
 * Agent → editor-store bridge.
 *
 * The agent action executor (`./executor.ts`) needs to read and write the
 * editor store at action-call time. Importing `useEditorStore` directly from
 * `../editor-store/store` would create a runtime cycle:
 *
 *   editor-store/store.ts → agent/agentSlice.ts → agent/executor.ts → editor-store/store.ts
 *
 * Instead, the store registers itself here once on creation, and the executor
 * looks up the live reference via `getAgentStoreApi()`. The cycle is broken
 * because this module has zero imports back into either side — it is generic
 * in the store-state shape so it does not need to depend on `EditorStore`.
 *
 * Wired up in `editor-store/store.ts` immediately after the store is created.
 */

interface AgentStoreApi<T = unknown> {
  getState(): T
  setState(partial: Partial<T>): void
}

let registered: AgentStoreApi<unknown> | null = null

export function setAgentStoreApi<T>(api: AgentStoreApi<T>): void {
  registered = api as AgentStoreApi<unknown>
}

export function getAgentStoreApi<T>(): AgentStoreApi<T> {
  if (!registered) {
    throw new Error(
      '[agent] Editor store API has not been registered. ' +
        'Make sure src/core/editor-store/store.ts has loaded before invoking the agent executor.',
    )
  }
  return registered as AgentStoreApi<T>
}
