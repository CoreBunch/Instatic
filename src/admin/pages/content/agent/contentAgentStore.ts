/**
 * Content-workspace agent store — a small standalone Zustand instance
 * holding ONLY the AgentSlice. Composed per ContentPage mount via
 * `createContentAgentStore(currentUser)`.
 *
 * Why standalone (not part of a bigger content store): the content
 * workspace is built on React hooks, not Zustand, so there's no parent
 * store to compose into. Building a content workspace store JUST for the
 * agent would be overkill — a per-mount tiny Zustand instance with one
 * slice is the smallest correct shape.
 *
 * Why per-mount (not module-level like useEditorStore): the content page
 * mounts/unmounts as the user navigates between admin pages; rebuilding
 * the store each mount keeps memory in check and ensures stale snapshot
 * closures don't survive a logout / user-swap. The site editor's store
 * is module-level because the editor session is the entire admin
 * lifetime, which doesn't apply here.
 */
import { create, type StateCreator } from 'zustand'
import { mutative } from 'zustand-mutative'
import { subscribeWithSelector } from 'zustand/middleware'
import {
  createAgentSlice,
  type AgentSlice,
} from '@site/agent'
import { contentAgentSliceConfig } from './agentSliceConfig.content'

type ContentAgentStore = AgentSlice

/**
 * Build a fresh Zustand store for the content workspace's agent panel.
 * No parameters — the agent's view of the world is reactive via the
 * registered ContentBridgeHandle, not closed-over at store-creation time.
 *
 * The `as unknown as ...` cast bridges the slice's site-editor-shaped
 * return type (`EditorStoreSliceCreator<AgentSlice>` — typed for the
 * combined site store) into our slice-only store. The slice only ever
 * touches AgentSlice keys at runtime, so the cast is structurally safe;
 * we accept the type widening here to avoid duplicating the slice
 * factory's logic for each store shape.
 */
export function createContentAgentStore() {
  const sliceCreator = createAgentSlice(contentAgentSliceConfig) as unknown as
    StateCreator<AgentSlice, [['zustand/mutative', never]], [], AgentSlice>
  return create<ContentAgentStore>()(
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
