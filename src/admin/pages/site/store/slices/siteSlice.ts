/**
 * siteSlice — orchestrator for the SiteDocument-owning slice.
 *
 * Implementation lives under `./site/` (one file per domain). This file just
 * wires the helpers + action factories together and re-exports the public
 * `SiteSlice` interface so the augmentation of `EditorStore` happens in a
 * single place.
 *
 * Domain layout:
 *   - `./site/types`            — SiteSlice interface + patch types + helpers contract
 *   - `./site/defaults`         — createDefaultSiteDocument + MAX_HISTORY
 *   - `./site/helpers`          — buildSiteHelpers (mutate* + patch-based history) + depthInTree
 *   - `./site/undoRedoActions`  — undo / redo
 *   - `./site/lifecycleActions` — createSite / loadSite / clearSite / updateSiteName
 *   - `./site/pageActions`      — page CRUD + template conversions
 *   - `./site/explorerActions`  — Site Explorer folder/order organization
 *   - `./site/nodeActions`      — the 11 named tree mutations + multi-select variants + dynamic bindings
 *   - `./site/breakpointActions`— breakpoint CRUD
 *   - `./site/settingsActions`  — site-level settings patch
 *   - `./site/fontActions`      — font library CRUD
 *   - `./site/framework/*`      — color / typography / spacing / preferences / preview / class reconciliation
 */

import type { EditorStoreSliceCreator } from '@site/store/types'
import { buildSiteHelpers } from './site/helpers'
import { createUndoRedoActions } from './site/undoRedoActions'
import { createLifecycleActions } from './site/lifecycleActions'
import { createPageActions } from './site/pageActions'
import { createExplorerActions } from './site/explorerActions'
import { createNodeActions } from './site/nodeActions'
import { createBreakpointActions } from './site/breakpointActions'
import { createSettingsActions } from './site/settingsActions'
import { createFontActions } from './site/fontActions'
import { createFrameworkColorActions } from './site/framework/colors'
import { createFrameworkTypographyActions } from './site/framework/typography'
import { createFrameworkSpacingActions } from './site/framework/spacing'
import { createFrameworkPreferencesActions } from './site/framework/preferences'
import { createFrameworkPreviewActions } from './site/framework/preview'
import type { SiteSlice } from './site/types'

// Re-export the public slice type for store wiring.


// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends SiteSlice {}
}

export const createSiteSlice: EditorStoreSliceCreator<SiteSlice> = (set, get) => {
  // Build the closure-shared mutation helpers once. Every action factory
  // receives this same object — so there is exactly one
  // `mutateActiveTree` / `mutateSite` per slice instance.
  const helpers = buildSiteHelpers(set, get)

  return {
    // ─── Owned state ─────────────────────────────────────────────────────────
    site: null,

    // Undo / redo history — Mutative patch-pair stacks (see HistoryEntry).
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    _historyCoalesceKey: null,

    // mutateAllPagesAndSite is the public entry point for the Super Import
    // wizard — one Cmd+Z reverts the entire import.
    mutateAllPagesAndSite: helpers.mutateAllPagesAndSite,

    // ─── Action surface ──────────────────────────────────────────────────────
    ...createUndoRedoActions(helpers),
    ...createLifecycleActions(helpers),
    ...createPageActions(helpers),
    ...createExplorerActions(helpers),
    ...createNodeActions(helpers),
    ...createBreakpointActions(helpers),
    ...createSettingsActions(helpers),
    ...createFontActions(helpers),
    ...createFrameworkColorActions(helpers),
    ...createFrameworkTypographyActions(helpers),
    ...createFrameworkSpacingActions(helpers),
    ...createFrameworkPreferencesActions(helpers),
    ...createFrameworkPreviewActions(helpers),
  }
}
