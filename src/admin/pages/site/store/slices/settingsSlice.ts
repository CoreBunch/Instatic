/**
 * settingsSlice — Phase 0 canonical slice for settings modal state.
 *
 * Owns the settings modal open/close state and the active section navigation.
 * This is UI-only state that must NOT trigger site autosave — it lives here,
 * not in siteSlice.
 *
 * Canonical Phase 0 fields (Contribution #457 / Guideline #193):
 *   - isSettingsOpen   — whether the settings modal is currently open
 *   - activeSection    — which nav section is displayed ('pages', 'breakpoints', etc.)
 *
 * Phase 6 (Task #183) will expand this slice with per-section state, keyboard
 * shortcut registry integration (Guideline #298), and any persisted preferences.
 *
 * @see Contribution #457 — Phase 0 Architectural Specification
 * @see Guideline #193    — Zustand Store Slice Guidelines
 * @see Guideline #323    — Phase 6 Settings Modal: Performance Patterns
 * @see Guideline #324    — Phase 6 Settings Modal: Implementation Architecture
 */

import type { StoreApi } from 'zustand'
import { rawReturn } from 'mutative'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { useAdminUi, bindEditorSettingsBridge } from '@admin/state/adminUi'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettingsSection =
  | 'general'
  | 'preferences'
  | 'shortcuts'
  | 'publishing'

export interface SettingsSlice {
  /** Whether the settings modal is currently open */
  isSettingsOpen: boolean

  /** The active settings nav section */
  activeSection: SettingsSection

  /** Open the settings modal, optionally jumping to a section */
  openSettings: (section?: SettingsSection) => void

  /** Close the settings modal */
  closeSettings: () => void

  /** Navigate to a different section within the open modal */
  setSettingsSection: (section: SettingsSection) => void
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

const DEFAULT_SECTION: SettingsSection = 'general'

// ---------------------------------------------------------------------------
// Slice factory
// ---------------------------------------------------------------------------

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends SettingsSlice {}
}

// Re-entrance guard for the editor ↔ adminUi settings sync. When an admin-
// shell caller (SettingsButton) opens settings, adminUi runs its setter THEN
// invokes the editor-side bridge below. Without this flag, the editor's
// `openSettings` action would call adminUi again, looping forever. We
// flip the flag, run the editor setState directly (bypassing the bridge
// back), then clear it.
let bridgeReentrancyGuard = false

export const createSettingsSlice: EditorStoreSliceCreator<SettingsSlice> = (set) => ({
  isSettingsOpen: false,
  activeSection: DEFAULT_SECTION,

  // Open / close publish to `adminUi` so admin pages outside the canvas
  // can mount the settings modal without subscribing to the full editor
  // store. The bridge keeps both stores in sync regardless of which side
  // initiated the change.
  openSettings: (section = DEFAULT_SECTION) => {
    set({ isSettingsOpen: true, activeSection: section })
    if (bridgeReentrancyGuard) return
    bridgeReentrancyGuard = true
    try {
      useAdminUi.getState().openSettings(section)
    } finally {
      bridgeReentrancyGuard = false
    }
  },

  closeSettings: () => {
    set({ isSettingsOpen: false })
    if (bridgeReentrancyGuard) return
    bridgeReentrancyGuard = true
    try {
      useAdminUi.getState().closeSettings()
    } finally {
      bridgeReentrancyGuard = false
    }
  },

  setSettingsSection: (section) =>
    set({ activeSection: section }),
})

// Reverse bridge: when adminUi.openSettings/closeSettings is called from
// the admin shell (e.g. via SettingsButton), mirror into the editor store
// so existing readers (uiSlice flags, spotlight actions, tests) stay in
// sync. `store.ts` wires the live editor store via
// `bindSettingsBridgeStoreApi` once it's constructed — the same one-shot
// pattern used for the agent executor bridge (`setAgentStoreApi`).
let editorStoreApi: StoreApi<EditorStore> | null = null

/**
 * Wire the editor store into the settings ↔ adminUi reverse bridge. Called
 * once from `store.ts` after the live store is constructed. The name avoids
 * colliding with `@core/plugins/runtime`'s same-purpose binder for the
 * plugin runtime — both used to be called `bindEditorStoreApi` and shadowed
 * each other at import time.
 */
export function bindSettingsBridgeStoreApi(api: StoreApi<EditorStore>): void {
  editorStoreApi = api
  bindEditorSettingsBridge((open, section) => {
    if (!editorStoreApi || bridgeReentrancyGuard) return
    bridgeReentrancyGuard = true
    try {
      // Bare StoreApi.setState (un-augmented type) takes a partial-returning
      // updater. rawReturn marks it as a raw value so Mutative skips draft
      // finalization (and its perf warning); zustand still merges the partial.
      editorStoreApi.setState((state) =>
        rawReturn({
          isSettingsOpen: open,
          activeSection:
            open && section ? (section as SettingsSection) : state.activeSection,
        }),
      )
    } finally {
      bridgeReentrancyGuard = false
    }
  })
}
