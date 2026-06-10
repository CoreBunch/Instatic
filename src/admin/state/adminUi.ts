/**
 * adminUi — admin-shell-wide UI state, intentionally kept small and
 * independent of the editor store.
 *
 * The editor store (`@site/store/store`) carries 11 slices and weighs
 * ~165 KB in its own chunk. Any module that subscribes to it transitively
 * drags that chunk into its graph. AdminPageLayout (Plugins / Users /
 * Account / plugin admin pages) only needs a few cross-shell signals —
 * specifically the "settings modal open" flag — and reading them from the
 * editor store made every non-editor admin page eagerly download the full
 * editor toolchain.
 *
 * This store lives outside `@site/` so the admin shell can subscribe
 * without pulling in any editor-only modules. The editor's
 * `settingsSlice` mirrors its open/close events into this store (see
 * `src/admin/pages/site/store/slices/settingsSlice.ts`), so editor and
 * admin views stay in sync without either one becoming dependent on
 * the other.
 *
 * Keep this store TINY. If a piece of state is only relevant inside the
 * canvas (selection, panels, breakpoints, …), it belongs in the editor
 * store. If admin pages outside the canvas need to read it, it belongs
 * here.
 */
import { create } from 'zustand'

export interface AdminUiState {
  /** True when the global Settings modal should be mounted + visible. */
  settingsOpen: boolean
  /** Section the modal opens to (e.g. "general", "pages", "breakpoints"). */
  settingsSection: string
  openSettings: (section?: string) => void
  closeSettings: () => void

  /** True when the global Site Import modal should be mounted + visible. */
  siteImportOpen: boolean
  openSiteImport: () => void
  closeSiteImport: () => void

  /**
   * Site summary surfaced in the admin toolbar (site name + favicon).
   * `siteName: null` means the shell has not loaded the identity yet; the
   * toolbar renders a skeleton instead of flashing a placeholder name.
   *
   * Populated by:
   *   - The Site editor's `usePersistence` hook when it hydrates the full site.
   *   - The lightweight `useSiteSummary` hook on AdminWorkspaceCanvasLayout
   *     and AdminPageLayout mount.
   *
   * Either path writes via `setSiteSummary` so the toolbar always reads
   * from one source regardless of which layout mounted first.
   */
  siteName: string | null
  siteFaviconUrl: string | null
  setSiteSummary: (summary: { name: string | null; faviconUrl: string | null }) => void

  /**
   * Full public path of the document currently being edited. `null` on every
   * non-editor admin route (Plugins / Users / Account / Dashboard / …) and
   * whenever no specific document is in focus (e.g. VC edit mode, an empty
   * Content workspace).
   *
   * Powers the toolbar's "Open live page" icon button — clicking opens this
   * path in a new tab. Stored as the full path (including leading slash and
   * any route-base prefix) so the same field can serve both a Site-editor
   * page (`/about`) and a Content-workspace entry (`/blog/getting-started`)
   * without the button needing to know which workspace published it.
   *
   * Written by the active workspace on every render; cleared on unmount.
   * Non-editor layouts never write it, so the field naturally stays `null`
   * there without either layout knowing about the other.
   */
  activeLivePath: string | null
  setActiveLivePath: (path: string | null) => void
}

/**
 * Editor-store bridge. Optional callback the editor store registers when
 * it's loaded so settings changes initiated from the admin shell propagate
 * into the editor's mirror state (`isSettingsOpen` / `activeSection`).
 * The editor side gates against re-entry — see `settingsSlice.ts`'s
 * `openSettings` / `closeSettings` actions, which delegate to a "publish
 * silently" path when invoked from this bridge.
 *
 * On non-editor admin pages, the editor store is never loaded and this
 * bridge stays `null` — adminUi alone is the truth.
 */
type EditorSettingsBridge = (open: boolean, section?: string) => void
let editorSettingsBridge: EditorSettingsBridge | null = null

/**
 * Called by the editor store's settings slice on initialization (once per
 * app load). Subsequent calls overwrite — exporters that hot-reload do not
 * accumulate stale bridges.
 */
export function bindEditorSettingsBridge(bridge: EditorSettingsBridge | null): void {
  editorSettingsBridge = bridge
}

export const useAdminUi = create<AdminUiState>((set) => ({
  settingsOpen: false,
  settingsSection: 'general',
  openSettings: (section) => {
    let nextSection: string | undefined
    set((state) => {
      nextSection = section ?? state.settingsSection
      return { settingsOpen: true, settingsSection: nextSection }
    })
    editorSettingsBridge?.(true, nextSection)
  },
  closeSettings: () => {
    set({ settingsOpen: false })
    editorSettingsBridge?.(false)
  },

  siteImportOpen: false,
  openSiteImport: () => set({ siteImportOpen: true }),
  closeSiteImport: () => set({ siteImportOpen: false }),

  siteName: null,
  siteFaviconUrl: null,
  setSiteSummary: ({ name, faviconUrl }) =>
    set({ siteName: name, siteFaviconUrl: faviconUrl }),

  activeLivePath: null,
  setActiveLivePath: (path) => set({ activeLivePath: path }),
}))
