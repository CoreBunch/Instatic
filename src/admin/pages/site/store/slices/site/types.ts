/**
 * Internal types for the siteSlice modules.
 *
 * `SiteSlice` is the public store-action surface; the helpers contract is the
 * private collaborator object passed from the slice creator into each action
 * factory in this directory.
 */

import type { StoreApi } from 'zustand'
import type { Draft, Patches } from 'mutative'
import type { FrameworkColorToken, FrameworkColorUtilityType, FrameworkPreferencesSettings, FrameworkScaleManualSize, FrameworkScaleMode, FrameworkSpacingClassGenerator, FrameworkSpacingGroup, FrameworkTypographyClassGenerator, FrameworkTypographyGroup } from '@core/framework-schema'
import type {
  DecorativeSiteExplorerSectionId,
  DynamicPropBinding,
  ExplorerPathChangePlan,
  Page,
  PageNode,
  NodeTree,
  Breakpoint,
  SiteDocument,
  SiteExplorerSectionId,
  SiteSettings,
  PageTemplateConfig,
  ConditionDef,
  StructuralExplorerRowOrder,
  StructuralSiteExplorerSectionId,
} from '@core/page-tree'
import type { FontEntry, FontToken } from '@core/fonts'
import type { ImportFragment } from '@core/htmlImport'
import type {
  NewStyleRule,
  ImportFontFamily,
  ImportColorToken,
  ImportFontToken,
  ImportScript,
  ImportStylesheet,
} from '@core/siteImport'
import type { FrameworkChangeImpact } from '@core/framework'
import type { EditorStore } from '@site/store/types'

// ---------------------------------------------------------------------------
// SuperImportHelpers — passed to mutateAllPagesAndSite recipes.
// ---------------------------------------------------------------------------

/**
 * Transaction helpers passed to the `mutateAllPagesAndSite` recipe. Each
 * method operates inside the same Immer producer so all changes land in a
 * single undoable history snapshot.
 */
export interface SuperImportHelpers {
  /**
   * Add a new page with the given title, slug, and body content.
   * Class names on fragment nodes are resolved to registry ids (auto-creating
   * bare classes for unknown names), exactly as `insertImportedNodes` does.
   * @returns The new page's generated id.
   */
  addPage(input: { id?: string; title: string; slug: string; nodeFragment: ImportFragment }): string

  /**
   * Add a new style rule to the global registry.
   * Appended after all existing rules (order = maxExisting + 1).
   * @returns The new rule's generated id.
   */
  addStyleRule(rule: NewStyleRule): string

  /**
   * Overwrite the content of an existing page (conflict: overwrite resolution).
   * Preserves `id`, `ownerUserId`, `createdByUserId`; replaces everything else.
   * Throws if `pageId` is not found.
   */
  overwritePage(pageId: string, input: { title: string; slug: string; nodeFragment: ImportFragment }): void

  /**
   * Overwrite an existing style rule (conflict: overwrite resolution).
   * Preserves `id`, `createdAt`, `order`; replaces all other fields.
   * Throws if `ruleId` is not found.
   */
  overwriteStyleRule(ruleId: string, rule: NewStyleRule): void

  /**
   * Merge reusable conditions into the site-level `site.conditions` registry,
   * deduped by id. Imported rules reference these by id via their
   * `contextStyles` keys.
   */
  addConditions(conditions: ConditionDef[]): void

  /**
   * Add custom font families (from imported `@font-face` blocks) to
   * `site.settings.fonts`. Each file's `src` is already a final media URL.
   * @returns The committed `{ id, family }` for each added font.
   */
  addFonts(fonts: ImportFontFamily[]): { id: string; family: string }[]

  /**
   * Merge already-installed font entries into `site.settings.fonts`.
   * @returns The committed `{ id, family }` for each added/replaced font.
   */
  addInstalledFonts(fonts: FontEntry[]): { id: string; family: string }[]

  /**
   * Add font tokens to `site.settings.fonts.tokens`, resolving token.family to
   * the matching installed family id when available.
   * @returns The committed `{ id, name, variable }` for each newly-added token.
   */
  addFontTokens(tokens: ImportFontToken[]): { id: string; name: string; variable: string }[]

  /**
   * Overwrite existing font tokens in place (import conflict: overwrite). The
   * existing token's id/name/variable are kept; family + fallback are replaced.
   * @returns The `{ id, name, variable }` for each overwritten token.
   */
  overwriteFontTokens(
    items: { existingTokenId: string; token: ImportFontToken }[],
  ): { id: string; name: string; variable: string }[]

  /**
   * Add colour tokens to the framework colours system as plain base tokens
   * (just `--<slug>`; no shades/tints/transparent or utility classes). A slug
   * already present is skipped. Reconciles framework classes afterwards.
   * @returns The committed `{ slug, value }` for each newly-added token.
   */
  addColorTokens(colors: ImportColorToken[]): { slug: string; value: string }[]

  /**
   * Overwrite existing framework colour tokens in place (import conflict:
   * overwrite). The existing token's id/slug are kept; only `lightValue` is
   * replaced. Reconciles framework classes afterwards.
   * @returns The `{ slug, value }` for each overwritten token.
   */
  overwriteColorTokens(
    items: { existingTokenId: string; value: string }[],
  ): { slug: string; value: string }[]

  /**
   * Add imported JS files as `SiteFile`s (`type: 'script'`) plus page-scoped
   * `site.runtime.scripts` entries, so they run where the source HTML linked
   * them.
   * @returns The committed `{ id, path }` for each added script.
   */
  addScripts(scripts: ImportScript[]): { id: string; path: string }[]

  /**
   * Add stylesheets kept as files (`mode: 'file'`) as `SiteFile`s
   * (`type: 'style'`) plus page-scoped `site.runtime.styles` entries, so each
   * applies exactly where the source HTML linked it.
   * @returns The committed `{ id, path }` for each added stylesheet.
   */
  addStylesheets(stylesheets: ImportStylesheet[]): { id: string; path: string }[]
}

// ---------------------------------------------------------------------------
// Public action surface — every method below appears as a top-level entry on
// the EditorStore.
// ---------------------------------------------------------------------------

export type ColorVariantOptions = { enabled: boolean; count: number }

export interface CreateFrameworkColorTokenInput {
  category?: string
  slug: string
  lightValue: string
  darkValue?: string
  darkModeEnabled?: boolean
  generateUtilities?: Partial<Record<FrameworkColorUtilityType, boolean>>
  generateTransparent?: boolean
  generateShades?: Partial<ColorVariantOptions>
  generateTints?: Partial<ColorVariantOptions>
}

export type UpdateFrameworkColorTokenPatch = Partial<{
  category: string
  slug: string
  lightValue: string
  darkValue: string
  darkModeEnabled: boolean
  generateUtilities: Partial<Record<FrameworkColorUtilityType, boolean>>
  generateTransparent: boolean
  generateShades: Partial<ColorVariantOptions>
  generateTints: Partial<ColorVariantOptions>
  order: number
}>

export type UpdateFrameworkTypographyGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  isDisabled: boolean
  /** Patch into the `min` breakpoint config — fields are merged, untouched fields preserved. */
  min: Partial<FrameworkTypographyGroup['min']>
  max: Partial<FrameworkTypographyGroup['max']>
  manualSizes: FrameworkScaleManualSize[]
}>

export type UpdateFrameworkSpacingGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  isDisabled: boolean
  min: Partial<FrameworkSpacingGroup['min']>
  max: Partial<FrameworkSpacingGroup['max']>
  manualSizes: FrameworkScaleManualSize[]
}>

export interface CreateFontTokenInput {
  name: string
  variable?: string
  familyId?: string | null
  fallback?: string
}

export type UpdateFontTokenPatch = Partial<{
  name: string
  variable: string
  familyId: string | null
  fallback: string
  order: number
}>

/**
 * One undoable transaction, stored as Mutative patch pairs scoped to the
 * SiteDocument (paths are relative to `site`, e.g. `['pages', 0, 'nodes', …]`).
 *
 * - `inverse` reverts the transaction (applied on undo).
 * - `forward` re-applies it (applied on redo).
 * - `coalesceKey` carries the in-progress input-burst identity so consecutive
 *   per-keystroke edits fold into a single entry (see `commitHistory`).
 */
export interface HistoryEntry {
  inverse: Patches
  forward: Patches
  coalesceKey: string | null
}

export interface SiteSlice {
  site: SiteDocument | null

  // SiteDocument lifecycle
  createSite: (name: string) => SiteDocument
  loadSite: (site: SiteDocument) => void
  clearSite: () => void
  updateSiteName: (name: string) => void

  // Page mutations
  addPage: (title: string, slug?: string) => Page
  deletePage: (pageId: string) => void
  renamePage: (pageId: string, title: string, slug?: string) => void
  duplicatePage: (sourcePageId: string, title: string, slug?: string) => Page
  reorderPages: (fromIndex: number, toIndex: number) => void
  convertPageToTemplate: (pageId: string, config: PageTemplateConfig) => void
  convertTemplateToPage: (pageId: string) => void
  createExplorerFolder: (sectionId: SiteExplorerSectionId, name: string, parentPath?: string) => string
  renameExplorerFolder: (sectionId: DecorativeSiteExplorerSectionId, folderId: string, name: string) => void
  deleteExplorerFolder: (sectionId: DecorativeSiteExplorerSectionId, folderId: string) => void
  moveExplorerFolder: (sectionId: DecorativeSiteExplorerSectionId, folderId: string, nextIndex: number) => void
  moveExplorerItem: (
    sectionId: DecorativeSiteExplorerSectionId,
    itemId: string,
    parentFolderId: string | null,
    nextIndex: number,
  ) => void
  moveExplorerItems: (
    sectionId: DecorativeSiteExplorerSectionId,
    itemIds: string[],
    parentFolderId: string | null,
    nextIndex: number,
  ) => void
  wrapExplorerItemsInFolder: (sectionId: DecorativeSiteExplorerSectionId, itemIds: string[], name: string) => string | null
  previewRenameExplorerFolder: (
    sectionId: StructuralSiteExplorerSectionId,
    folderPath: string,
    nextFolderPath: string,
  ) => ExplorerPathChangePlan
  previewMoveExplorerFolder: (
    sectionId: StructuralSiteExplorerSectionId,
    folderPath: string,
    nextParentPath: string | undefined,
  ) => ExplorerPathChangePlan
  previewMoveExplorerItem: (
    sectionId: StructuralSiteExplorerSectionId,
    itemId: string,
    nextParentPath: string | undefined,
  ) => ExplorerPathChangePlan
  previewDeleteExplorerFolder: (
    sectionId: StructuralSiteExplorerSectionId,
    folderPath: string,
  ) => ExplorerPathChangePlan
  commitExplorerPathChange: (plan: ExplorerPathChangePlan) => void
  toggleStructuralExplorerFolder: (sectionId: StructuralSiteExplorerSectionId, folderPath: string) => void
  moveStructuralExplorerRow: (
    sectionId: StructuralSiteExplorerSectionId,
    row: Omit<StructuralExplorerRowOrder, 'order'>,
    nextIndex: number,
  ) => void
  setPageAsHomepage: (pageId: string) => void

  // Node mutations (operate on the active page)
  insertNode: (moduleId: string, defaults: Record<string, unknown>, parentId: string, index?: number) => string

  /**
   * Insert a fragment of imported HTML nodes into the active tree under `parentId`.
   * Merges all `fragment.nodes` into the tree and wires `fragment.rootIds` as children
   * of `parentId` at `opts.index` (appended when omitted). One undo step.
   * Returns the inserted root IDs, or an empty array when the parent does not accept children.
   *
   * `opts.styleRules` / `opts.conditions` are rules parsed from `<style>` blocks
   * in the imported HTML (via `cssToStyleRules`); they are committed into the
   * registry (Selectors panel) and bound to matching `class=` tokens in the
   * same undo step.
   */
  insertImportedNodes: (
    parentId: string,
    fragment: ImportFragment,
    opts?: { index?: number; styleRules?: NewStyleRule[]; conditions?: ConditionDef[] },
  ) => string[]

  /**
   * Insert a `base.visual-component-ref` node into the active document.
   *
   * - In VC mode: inserts via `mutateActiveTree` and guards against cyclic references.
   *   Returns `null` if the insertion would create a cycle.
   * - In page mode: inserts via `insertNode`. Returns `null` if `componentId` is empty.
   * - Auto-materializes `base.slot-instance` children after insertion via `syncSlotInstances`.
   * - `index` is forwarded to `insertNode` so callers can drop the new ref at a
   *   specific sibling position (used by the resolveInsertLocation flow when
   *   pasting / right-clicking a leaf target).
   * - Returns the new node's id on success, or `null` on no-op / cycle prevented.
   */
  insertComponentRef: (parentId: string, componentId: string, index?: number) => string | null
  deleteNode: (nodeId: string) => void
  /** Multi-delete: removes every id and its descendants in one undo step. */
  deleteNodes: (nodeIds: string[]) => void
  updateNodeProps: (nodeId: string, patch: Record<string, unknown>) => void
  /**
   * Patch a node's inline styles (`node.inlineStyles`) — the per-node `style=""`
   * layer emitted by the publisher. A `null`/`undefined`/`''` value in the patch
   * removes that property; an empty resulting bag clears the field entirely.
   * Inline styles are BASE-ONLY (no breakpoint/condition axis), mirroring real
   * HTML inline styles.
   */
  setNodeInlineStyles: (nodeId: string, patch: Record<string, string | number | null | undefined>) => void
  /** Remove a single property from a node's inline styles. */
  removeNodeInlineStyleProperty: (nodeId: string, propKey: string) => void
  /** Remove ALL inline styles from a node (clears the `inlineStyles` field). */
  clearNodeInlineStyles: (nodeId: string) => void
  setBreakpointOverride: (nodeId: string, breakpointId: string, patch: Record<string, unknown>) => void
  clearBreakpointOverride: (nodeId: string, breakpointId: string) => void
  renameNode: (nodeId: string, label: string) => void
  toggleNodeLocked: (nodeId: string) => void
  toggleNodeHidden: (nodeId: string) => void
  moveNode: (nodeId: string, newParentId: string, newIndex: number) => void
  /** Multi-move: moves every top-level id into newParent at newIndex (single undo step). */
  moveNodes: (nodeIds: string[], newParentId: string, newIndex: number) => void
  duplicateNode: (nodeId: string) => string
  /** Multi-duplicate: duplicates every id in place (single undo step). Returns the new ids. */
  duplicateNodes: (nodeIds: string[]) => string[]
  wrapNode: (nodeId: string, containerModuleId: string, defaults?: Record<string, unknown>) => string
  /**
   * Wrap a multi-selection inside one new container with closest-common-ancestor
   * semantics. Returns the new wrapper id, or `null` when the selection is empty.
   */
  wrapNodes: (nodeIds: string[], containerModuleId: string, defaults?: Record<string, unknown>) => string | null
  setNodeDynamicBinding: (nodeId: string, propKey: string, binding: DynamicPropBinding) => void
  clearNodeDynamicBinding: (nodeId: string, propKey: string) => void

  // Breakpoint mutations
  addBreakpoint: (bp: Omit<Breakpoint, 'id'>) => Breakpoint
  updateBreakpoint: (id: string, patch: Partial<Omit<Breakpoint, 'id'>>) => void
  removeBreakpoint: (id: string) => void
  reorderBreakpoints: (fromIndex: number, toIndex: number) => void

  // SiteDocument settings mutations
  updateSiteSettings: (patch: Partial<SiteSettings>) => void

  // Framework color mutations
  createFrameworkColorToken: (input: CreateFrameworkColorTokenInput) => FrameworkColorToken
  updateFrameworkColorToken: (tokenId: string, patch: UpdateFrameworkColorTokenPatch) => void
  duplicateFrameworkColorToken: (tokenId: string) => FrameworkColorToken | null
  reorderFrameworkColorToken: (tokenId: string, direction: 'up' | 'down') => void
  deleteFrameworkColorToken: (tokenId: string) => void

  // Framework preferences
  updateFrameworkPreferences: (patch: Partial<FrameworkPreferencesSettings>) => void

  // Framework typography mutations
  toggleFrameworkTypographyDisabled: () => void
  createFrameworkTypographyGroup: () => FrameworkTypographyGroup
  updateFrameworkTypographyGroup: (groupId: string, patch: UpdateFrameworkTypographyGroupPatch) => void
  duplicateFrameworkTypographyGroup: (groupId: string) => FrameworkTypographyGroup | null
  resetFrameworkTypographyGroup: (groupId: string) => void
  deleteFrameworkTypographyGroup: (groupId: string) => void
  upsertFrameworkTypographyManualSize: (
    groupId: string,
    sizeId: string,
    patch: Partial<FrameworkScaleManualSize>,
  ) => void
  setFrameworkTypographyClassGenerators: (classes: FrameworkTypographyClassGenerator[]) => void

  // Framework spacing mutations
  toggleFrameworkSpacingDisabled: () => void
  createFrameworkSpacingGroup: () => FrameworkSpacingGroup
  updateFrameworkSpacingGroup: (groupId: string, patch: UpdateFrameworkSpacingGroupPatch) => void
  duplicateFrameworkSpacingGroup: (groupId: string) => FrameworkSpacingGroup | null
  resetFrameworkSpacingGroup: (groupId: string) => void
  deleteFrameworkSpacingGroup: (groupId: string) => void
  upsertFrameworkSpacingManualSize: (
    groupId: string,
    sizeId: string,
    patch: Partial<FrameworkScaleManualSize>,
  ) => void
  setFrameworkSpacingClassGenerators: (classes: FrameworkSpacingClassGenerator[]) => void

  // ─── Site fonts library ─────────────────────────────────────────────────
  /**
   * Add a font to the library. The caller (UI) is responsible for first calling
   * the server install endpoint, which downloads the woff2 files; the resulting
   * `FontEntry` returned by the server is what gets passed here. The action
   * itself is purely client-side — it only mutates `settings.fonts.items`.
   * Duplicate `family` (case-insensitive) on the same `source` is a no-op.
   */
  addFont: (entry: FontEntry) => FontEntry
  /**
   * Remove an installed font by id. Server file cleanup is the caller's job.
   * Returns false when no entry was removed, including when a font token still
   * references the family.
   */
  removeFont: (fontId: string) => boolean
  createFontToken: (input: CreateFontTokenInput) => FontToken
  updateFontToken: (tokenId: string, patch: UpdateFontTokenPatch) => void
  deleteFontToken: (tokenId: string) => boolean

  /**
   * Preview the destructive impact of a framework-related change without
   * committing it. Returns the list of framework classes that would be
   * removed and every place those classes are still assigned, or `null`
   * if the change removes nothing-in-use (silent commit is fine).
   *
   * The caller writes a small mutation function that mirrors what the
   * actual store action would do at the framework-settings level. This
   * function clones the current site, applies the mutation to the clone,
   * runs every framework reconciler, then diffs.
   */
  previewFrameworkChange: (
    applyChange: (site: SiteDocument) => void,
  ) => FrameworkChangeImpact | null

  // ─── Super Import ─────────────────────────────────────────────────────────
  /**
   * Mutate the entire site — all pages and style rules — in ONE undoable
   * history snapshot. The recipe receives a SiteDocument draft and helpers
   * that mint new pages / style rules or overwrite existing ones.
   *
   * Used by the Super Import wizard so Cmd+Z reverts the whole import in a
   * single press. Returns `true` when the recipe produced at least one real
   * mutation; `false` for explicit no-ops.
   */
  mutateAllPagesAndSite(fn: (site: SiteDocument, helpers: SuperImportHelpers) => SiteMutationResult): boolean

  // ─── Undo / Redo ──────────────────────────────────────────────────────────
  /**
   * Per-transaction Mutative patch pairs — most recent last. Each entry stores
   * `inverse` (applied on undo) + `forward` (applied on redo) patches scoped to
   * the SiteDocument, so a step costs O(change) memory instead of a full-site
   * clone. See `HistoryEntry`.
   */
  _historyPast: HistoryEntry[]
  /** Entries popped by undo, available for redo — most recent last */
  _historyFuture: HistoryEntry[]
  /** True if there's at least one state to undo to */
  canUndo: boolean
  /** True if there's at least one state to redo to */
  canRedo: boolean
  /**
   * Identity key of the in-progress history-coalescing burst, or `null`.
   *
   * Continuous-input mutations (per-keystroke text/number edits) pass a stable
   * key derived from their target (`props:<nodeId>:<prop>`, etc.). While the
   * incoming key matches this one, the mutation folds into the existing
   * top-of-stack snapshot instead of cloning the whole site again — so typing a
   * word is ONE undo step, not one per character. Any non-coalescing mutation,
   * `undo`/`redo`, or a site (re)load resets it to `null`, ending the burst.
   */
  _historyCoalesceKey: string | null
  undo: () => void
  redo: () => void
}

// ---------------------------------------------------------------------------
// Internal helpers contract — passed from the slice creator into each action
// factory. Centralises the closure-bound mutation helpers so action files do
// not need to re-implement history snapshotting or active-tree routing.
// ---------------------------------------------------------------------------

/**
 * Recipe accepted by `set` / the `mutate*` helpers. Mirrors the
 * `zustand-mutative` middleware signature: a recipe receives a Mutative draft
 * and mutates it in place (returning `void`); returning a replacement value is
 * also tolerated for full-state replacement.
 */
export type SiteSliceRecipe = (state: Draft<EditorStore>) => void | EditorStore

/**
 * Mutation recipes return `false` when they intentionally did not change the
 * SiteDocument. `void` and `true` both mean the recipe performed a mutation.
 */
export type SiteMutationResult = void | boolean

export interface SiteSliceHelpers {
  /** Raw set/get from the slice creator. Use only when no helper covers the case. */
  set: (recipe: SiteSliceRecipe) => void
  get: StoreApi<EditorStore>['getState']

  /**
   * Mutate the active node tree — commits undo history only on real changes.
   *
   * Routes to the correct tree based on `activeDocument`:
   *   - Page mode (null or kind === 'page'): passes the active Page directly —
   *     Page IS NodeTree<PageNode> so no conversion needed.
   *   - VC mode (kind === 'visualComponent'): passes vc.tree directly —
   *     VCNode (= BaseNode) is structurally compatible with PageNode, so the
   *     cast is safe for tree mutations that operate on BaseNode-level fields.
   *     After the mutation, propagates any change in the VC's slot-outlet set
   *     to every consumer VC ref across all pages via `syncSlotInstances`.
   */
  mutateActiveTree: (
    fn: (tree: NodeTree<PageNode>) => SiteMutationResult,
    opts?: { coalesceKey?: string },
  ) => boolean

  /**
   * Mutate the active node tree AND the surrounding site — auto-snapshots
   * undo history only on real changes. Same active-document routing as `mutateActiveTree`, plus
   * a `SiteDocument` draft so callers can also mutate site-level state
   * (e.g. `site.styleRules` for scoped-class cloning) in one atomic recipe.
   */
  mutateActiveTreeAndSite: (
    fn: (tree: NodeTree<PageNode>, site: SiteDocument) => SiteMutationResult,
  ) => boolean

  /** Mutate the site — commits undo history only on real changes. */
  mutateSite: (
    fn: (site: SiteDocument) => SiteMutationResult,
    opts?: { coalesceKey?: string },
  ) => boolean

  /** Mutate the site and reconcile Site Explorer organization after a real change. */
  mutateSiteWithExplorerReconcile: (fn: (site: SiteDocument) => SiteMutationResult) => boolean

  /**
   * Mutate the full editor state and site document in one undoable transaction.
   * Use only when a site mutation must also update editor-local state such as
   * the active document or selection.
   */
  mutateSiteState: (
    fn: (state: Draft<EditorStore>, site: SiteDocument) => SiteMutationResult,
  ) => boolean

  /**
   * Mutate all pages and style rules in one undoable history snapshot.
   * See `SiteSlice.mutateAllPagesAndSite` for the full contract.
   */
  mutateAllPagesAndSite: (
    fn: (site: SiteDocument, helpers: SuperImportHelpers) => SiteMutationResult,
  ) => boolean
}
