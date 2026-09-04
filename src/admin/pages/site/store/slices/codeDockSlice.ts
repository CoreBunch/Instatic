import type { EditorStoreSliceCreator } from '@site/store/types'
import { withCodeDockDraft, type CodeDockDraft } from './codeDockDrafts'

/**
 * God Mode / Code Dock slice — the mode flag plus the layout state of the
 * bottom HTML | CSS | JS Code Dock. All of it is plain layout state,
 * persisted per workspace by `siteEditorLayoutPersistence`.
 * Feature doc: docs/features/god-mode.md.
 */
export type CodeDockPanelId = 'html' | 'css' | 'js'
export type CodeDockPanelVisibility = Record<CodeDockPanelId, boolean>
export type CodeDockColumnWeights = Record<CodeDockPanelId, number>
export const CODE_DOCK_PANEL_IDS: readonly CodeDockPanelId[] = ['html', 'css', 'js']
export const CODE_DOCK_MIN_HEIGHT = 120
export const CODE_DOCK_MAX_HEIGHT = 800
export const CODE_DOCK_DEFAULT_HEIGHT = 280
/**
 * Below this a column would read as gone even before the CSS minimum width
 * catches it, so weights are floored here (and at restore) and a column
 * shown again starts from an equal share.
 */
export const CODE_DOCK_MIN_COLUMN_WEIGHT = 0.2

export function clampCodeDockColumnWeight(weight: number): number {
  return Math.max(CODE_DOCK_MIN_COLUMN_WEIGHT, weight)
}

export function isCodeDockPanelId(value: unknown): value is CodeDockPanelId {
  return value === 'html' || value === 'css' || value === 'js'
}

export function clampCodeDockHeight(height: number): number {
  return Math.min(CODE_DOCK_MAX_HEIGHT, Math.max(CODE_DOCK_MIN_HEIGHT, height))
}

interface CodeDockSlice {
  /**
   * Whether God Mode is currently active: right properties sidebar hidden,
   * Code Dock shown at the bottom of the site editor. Only togglable when
   * the `godMode` editor preference is enabled AND the user holds
   * structure-edit rights — the UI gates on both; the flag itself is plain
   * layout state so it can persist per workspace.
   */
  godModeActive: boolean
  /** Code Dock pixel height (clamped to CODE_DOCK_MIN/MAX_HEIGHT). */
  codeDockHeight: number
  /** Per-column visibility of the three code panels. */
  codeDockPanels: CodeDockPanelVisibility
  /** Panel shown when the dock is in narrow-window tabbed mode. */
  codeDockActiveTab: CodeDockPanelId
  /** Relative flex weights of the visible columns (all > 0). */
  codeDockColumnWeights: CodeDockColumnWeights
  /** The panels' unapplied buffers, by document key — see `codeDockDrafts.ts`. */
  codeDockDrafts: Record<string, CodeDockDraft>

  /** Set God Mode on/off (idempotent). */
  setGodModeActive: (active: boolean) => void
  /** Toggle God Mode. */
  toggleGodMode: () => void
  /** Set the Code Dock height, clamped to the allowed range. */
  setCodeDockHeight: (height: number) => void
  /** Show / hide one code panel column. */
  toggleCodeDockPanel: (panel: CodeDockPanelId) => void
  /** Pick the visible panel while the dock is in tabbed (narrow) mode. */
  setCodeDockActiveTab: (panel: CodeDockPanelId) => void
  /** Replace column weights. Ignored unless every weight is finite and > 0. */
  setCodeDockColumnWeights: (weights: CodeDockColumnWeights) => void
  /** Store (or, with null, drop) a panel's draft for a document key. */
  setCodeDockDraft: (key: string, draft: CodeDockDraft | null) => void
}

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends CodeDockSlice {}
}

export const createCodeDockSlice: EditorStoreSliceCreator<CodeDockSlice> = (set, get) => ({
  godModeActive: false,
  codeDockHeight: CODE_DOCK_DEFAULT_HEIGHT,
  codeDockPanels: { html: true, css: true, js: true },
  codeDockActiveTab: 'html',
  codeDockColumnWeights: { html: 1, css: 1, js: 1 },
  codeDockDrafts: {},

  setGodModeActive: (active) => {
    if (Object.is(get().godModeActive, active)) return
    set({ godModeActive: active })
  },

  toggleGodMode: () => set({ godModeActive: !get().godModeActive }),

  setCodeDockHeight: (height) => {
    const next = clampCodeDockHeight(height)
    if (Object.is(get().codeDockHeight, next)) return
    set({ codeDockHeight: next })
  },

  toggleCodeDockPanel: (panel) =>
    set((state) => {
      const show = !state.codeDockPanels[panel]
      state.codeDockPanels[panel] = show
      // A column that was dragged down to its minimum comes back at an
      // equal share, not as a sliver.
      if (show && state.codeDockColumnWeights[panel] < 1) state.codeDockColumnWeights[panel] = 1
    }),

  setCodeDockActiveTab: (panel) => {
    if (Object.is(get().codeDockActiveTab, panel)) return
    set({ codeDockActiveTab: panel })
  },

  setCodeDockColumnWeights: (weights) => {
    const valid = CODE_DOCK_PANEL_IDS.every(
      (panel) => Number.isFinite(weights[panel]) && weights[panel] > 0,
    )
    if (!valid) return
    set({
      codeDockColumnWeights: Object.fromEntries(
        CODE_DOCK_PANEL_IDS.map((panel) => [panel, clampCodeDockColumnWeight(weights[panel])]),
      ) as CodeDockColumnWeights,
    })
  },

  setCodeDockDraft: (key, draft) => {
    const current = get().codeDockDrafts
    if (draft === null && !(key in current)) return
    set({ codeDockDrafts: withCodeDockDraft(current, key, draft) })
  },
})
