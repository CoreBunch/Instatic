/**
 * styleRule slice — public type surface.
 *
 * `StyleRuleSlice` is the action + UI-state contract for the site's global
 * style-rule registry (`site.styleRules`, a flat map of {@link StyleRule}).
 * A style rule is either:
 *   - `kind: 'class'`   — attached to nodes via `node.classIds`, and
 *   - `kind: 'ambient'` — attached by CSS selector matching (`h1 > span`,
 *     `.hero .title`, `a:hover`, …), never written to a class attribute.
 *
 * The historical "class" vocabulary survives in the public *action* names
 * (`createClass`, `addNodeClass`, `activeClassId`, …) because a subset of them
 * — the node↔class assignment actions — are genuinely class-kind-only. The
 * slice container itself is named after the engine type it owns: StyleRule.
 */

import type { StyleRule, CSSPropertyBag, Condition, ConditionDef } from '@core/page-tree'
import type { NewStyleRule } from '@core/siteImport'

/**
 * Inputs accepted by `createAmbientRule`. `selector` is required (e.g.
 * `'h1 > span'`); `name` defaults to the selector text for display purposes.
 */
interface CreateAmbientRuleInput {
  selector: string
  name?: string
  styles?: Partial<CSSPropertyBag>
  contextStyles?: Record<string, Partial<CSSPropertyBag>>
}

export interface ClassPreviewAssignment {
  nodeId: string
  classId: string
}

/**
 * Transient style preview applied on top of a class while a user hovers a
 * suggestion in a property control (e.g. spacing token dropdown). The
 * canvas style injector reads this and emits a higher-specificity rule so
 * the change is visible without committing to history.
 */
interface ClassStylesPreview {
  classId: string
  /** Breakpoint id to scope the preview to, or null/undefined for the base styles. */
  breakpointId?: string | null
  styles: Partial<CSSPropertyBag>
}

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface StyleRuleSlice {
  // ── UI state ──────────────────────────────────────────────────────────────
  /** The class currently being edited in the Class Composer (null = none) */
  activeClassId: string | null
  setActiveClass(id: string | null): void

  /**
   * When true, the Properties panel edits the selected node's inline styles
   * (`node.inlineStyles`) instead of a class. Mutually exclusive with
   * `activeClassId` — selecting a class clears this, and enabling this clears
   * the active class. Reset to false whenever the node selection changes.
   */
  inlineStyleEditing: boolean
  setInlineStyleEditing(active: boolean): void

  /** Transient class assignment previewed on the canvas while hovering a suggestion. */
  previewClassAssignment: ClassPreviewAssignment | null
  setPreviewNodeClass(nodeId: string, classId: string): void
  clearPreviewNodeClass(nodeId?: string, classId?: string): void

  /** Transient style patch previewed on the canvas while hovering a suggestion. */
  previewClassStyles: ClassStylesPreview | null
  setPreviewClassStyles(preview: ClassStylesPreview): void
  clearPreviewClassStyles(classId?: string): void

  // ── CRUD ──────────────────────────────────────────────────────────────────
  /**
   * Create a new class with the given name and optional initial styles.
   * Returns the new StyleRule so callers can immediately activate it.
   * Throws if a class with the same name already exists.
   */
  createClass(name: string, styles?: Partial<CSSPropertyBag>): StyleRule

  /**
   * Create an ambient style rule — one whose `selector` is not a single class
   * name (e.g. `h1`, `h1 > span`, `.hero .title`, `a:hover`). Ambient rules
   * attach by CSS matching at render time; they are never written to a
   * node's `class=` attribute. The CSS importer is the primary caller.
   *
   * Throws if the selector is empty or syntactically invalid.
   */
  createAmbientRule(input: CreateAmbientRuleInput): StyleRule

  /** Shallow-merge a style patch into a class's base styles. */
  updateClassStyles(classId: string, patch: Partial<CSSPropertyBag>): void

  /**
   * Apply a batch of CSS rules parsed from authored CSS text (see
   * `cssToStyleRules`) to the registry with UPSERT semantics: a rule whose
   * `name` (class) or `selector` (ambient) already exists is MERGED onto the
   * existing rule — base `styles` and every per-context override — so the same
   * call both creates new selectors and EDITS existing ones. New selectors are
   * minted at the end of the cascade. Framework-generated/locked token classes
   * are never overwritten. Any referenced reusable conditions are registered
   * first. The whole batch is one undo step. Returns how many rules were
   * created vs. updated.
   *
   * This is the engine behind the agent's `applyCss` tool and the element-less
   * `<style>` payload path — the editing counterpart to the additive
   * `mergeImportedStyleRules` used when importing structure (which deliberately
   * does NOT clobber shared classes as a side effect of inserting nodes).
   */
  upsertCssRules(
    rules: NewStyleRule[],
    conditions: ConditionDef[],
  ): { created: number; updated: number }

  // ── Per-context overrides (unified viewport-context + custom-condition axis) ─
  /**
   * Shallow-merge a style patch into a class's override bag for one editing
   * context. `contextId` is either a viewport-context id (`site.breakpoints`)
   * or a custom-condition id (`site.conditions`). Keys set to undefined/null
   * are removed. Replaces the old `setClassBreakpointStyles` +
   * `updateConditionalLayerStyles` (they were the same operation twice).
   */
  setClassContextStyles(
    classId: string,
    contextId: string,
    patch: Partial<CSSPropertyBag>,
  ): void

  // ── Site-level reusable conditions (custom @media / @container / @supports) ─
  /**
   * Add a reusable condition to the site-level `site.conditions` registry,
   * deduped by deterministic id. Returns the condition id (existing or new).
   */
  addCondition(condition: Condition, label?: string): string

  /**
   * Remove a condition from the registry AND clear its override bag from every
   * class that used it. No-op if the condition id is unknown.
   */
  removeCondition(conditionId: string): void

  /** Rename a condition's display label (registry only; id/condition unchanged). */
  renameCondition(conditionId: string, label: string): void

  /**
   * Edit a condition's query/kind (and optionally label) in place, keeping its
   * id stable so every class's `contextStyles[id]` overrides survive the edit.
   * (The id no longer matches `conditionId(condition)` afterwards — that only
   * affects future import dedup, an acceptable edge case.)
   */
  updateCondition(conditionId: string, condition: Condition, label?: string): void

  /**
   * Convenience for the style panel: ensure `condition` exists in the registry
   * and that `classId` carries an (initially empty) override bag under it, so
   * the context becomes editable. Returns the condition id, or null if the rule
   * doesn't exist / is locked.
   */
  addClassCondition(classId: string, condition: Condition): string | null

  /** Remove a class's override bag for one context (no registry change). */
  removeClassContext(classId: string, contextId: string): void

  /**
   * Fully remove a CSS property from a class — from base styles and from every
   * per-context override. Used by the X / clear affordances on visual switchers
   * (LayoutSection) where "clear this property" must mean "make it disappear"
   * regardless of which context is active. No-ops (and does NOT push history)
   * if the property isn't set anywhere.
   */
  removeClassStyleProperty(classId: string, property: keyof CSSPropertyBag): void

  /**
   * Fully remove SEVERAL CSS properties from a class in a single undo step —
   * each from base styles and every per-context override. Used when one action
   * must prune a group of related properties at once (e.g. clearing `display`
   * also clears the flex/grid container properties it governed, which would
   * otherwise linger as invisible orphans). No-ops if none are set anywhere.
   */
  clearClassStyleProperties(classId: string, properties: ReadonlyArray<keyof CSSPropertyBag>): void

  /** Ensure a hidden node-scoped class exists for module instance style fields. */
  ensureNodeStyleClass(nodeId: string, moduleName?: string): StyleRule | null

  /**
   * Rename a style rule.
   * - class-kind rules accept one class token and rebuild `selector` from it.
   * - ambient rules accept a full CSS selector and keep `name` aligned to it
   *   because selector surfaces display the selector, not an old class label.
   */
  renameClass(classId: string, name: string): void

  /** Duplicate a reusable class. Returns the new class, or null if not found. */
  duplicateClass(classId: string): StyleRule | null

  /**
   * Duplicate several reusable classes at once (Selectors panel bulk action).
   * Locked / non-user-visible ids are skipped. Returns the created copies.
   */
  duplicateClasses(classIds: string[]): StyleRule[]

  /** Delete a class and remove it from all nodes that reference it. */
  deleteClass(classId: string): void

  /**
   * Delete several classes in one batched mutation (Selectors panel bulk
   * action) so the whole removal is a single undo step. Locked classes are
   * skipped; every deleted id is scrubbed from node/VC class references and
   * from the active / selected-selector state.
   */
  deleteClasses(classIds: string[]): void

  // ── Node ↔ class assignment ───────────────────────────────────────────────
  /** Append a classId to a node's classIds (no-op if already present). */
  addNodeClass(nodeId: string, classId: string): void

  /**
   * Append several classIds to a node in ONE batched mutation, so a bulk
   * "apply" is a single undo step. Ambient rules and already-present ids are
   * skipped. No-op (no history entry) when nothing new would be added.
   */
  addNodeClasses(nodeId: string, classIds: string[]): void

  /** Remove a classId from a node's classIds (no-op if not present). */
  removeNodeClass(nodeId: string, classId: string): void

  /** Swap two classIds by index within a node's classIds array. */
  reorderNodeClasses(nodeId: string, fromIndex: number, toIndex: number): void

  /**
   * Move a classId one position up ('up' = lower index = lower cascade priority)
   * or down ('down' = higher index = higher cascade priority) in a node's classIds array.
   * No-op at array boundaries (Guideline #242 — no-op mutation guard).
   */
  reorderNodeClass(nodeId: string, classId: string, direction: 'up' | 'down'): void
}
