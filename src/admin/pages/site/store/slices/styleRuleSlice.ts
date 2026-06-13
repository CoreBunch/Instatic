/**
 * styleRuleSlice — orchestrator for the CSS style-rule system store slice.
 *
 * Owns the site's global style-rule registry (`site.styleRules`, a flat map of
 * {@link StyleRule}) plus the per-node class assignments (`node.classIds`) and
 * the transient Class Composer / preview UI state. A style rule is either a
 * `kind: 'class'` rule (attached via `node.classIds`) or a `kind: 'ambient'`
 * rule (attached by CSS selector matching — full selectors, descendant
 * combinators, pseudos, …). The slice manages both.
 *
 * Implementation lives under `./styleRule/` (one file per responsibility).
 * This file just wires the helpers + action factories together and re-exports
 * the public `StyleRuleSlice` type + boundary types so the augmentation of
 * `EditorStore` happens in a single place — same orchestrator pattern as
 * `siteSlice.ts`.
 *
 * Domain layout:
 *   - `./styleRule/types`            — StyleRuleSlice interface + boundary types
 *   - `./styleRule/helpers`          — pure helpers (order, diff, node lookup)
 *   - `./styleRule/uiStateActions`   — Class Composer + canvas preview UI state
 *   - `./styleRule/crudActions`      — create / update style rules + context bags
 *   - `./styleRule/conditionActions` — site-level reusable conditions
 *   - `./styleRule/propertyActions`  — clear-property-everywhere affordances
 *   - `./styleRule/registryActions`  — rename / duplicate / delete + node-style class
 *   - `./styleRule/assignmentActions`— node ↔ class assignment + reorder
 *
 * All SiteDocument writes go through the shared `mutateSite` / `mutateSiteState`
 * helpers (never `pushHistory` directly) so undo history stays centralized.
 *
 * Guideline #242 — no-op guard: every setter bails out when the new value
 * equals the current value to prevent re-render loops.
 */

import type { EditorStoreSliceCreator } from '@site/store/types'
import { buildSiteHelpers } from './site/helpers'
import type { StyleRuleSlice } from './styleRule/types'
import { createUiStateActions } from './styleRule/uiStateActions'
import { createCrudActions } from './styleRule/crudActions'
import { createConditionActions } from './styleRule/conditionActions'
import { createPropertyActions } from './styleRule/propertyActions'
import { createRegistryActions } from './styleRule/registryActions'
import { createAssignmentActions } from './styleRule/assignmentActions'

// Re-export the public slice + boundary types for store wiring and consumers
// (e.g. the canvas reads `ClassPreviewAssignment`).
export type {
  ClassPreviewAssignment,
} from './styleRule/types'

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends StyleRuleSlice {}
}

export const createStyleRuleSlice: EditorStoreSliceCreator<StyleRuleSlice> = (set, get) => {
  // Build the closure-shared mutation helpers once. Every action factory
  // receives this same object — so there is exactly one
  // `mutateSite` / `mutateSiteState` per slice instance.
  const helpers = buildSiteHelpers(set, get)

  return {
    // ─── Owned UI state ────────────────────────────────────────────────────
    activeClassId: null,
    inlineStyleEditing: false,
    previewClassAssignment: null,
    previewClassStyles: null,

    // ─── Action surface ────────────────────────────────────────────────────
    ...createUiStateActions(helpers),
    ...createCrudActions(helpers),
    ...createConditionActions(helpers),
    ...createPropertyActions(helpers),
    ...createRegistryActions(helpers),
    ...createAssignmentActions(helpers),
  }
}
