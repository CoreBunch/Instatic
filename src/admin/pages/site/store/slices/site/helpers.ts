/**
 * Closure-shared helpers for the site slice.
 *
 * `buildSiteHelpers(set, get)` returns the shared mutation helpers packaged
 * into a single object that gets passed to every per-domain action factory.
 *
 * `depthInTree` is a pure utility consumed by the helpers / action factories —
 * it lives here so it sits next to the active tree code that uses it.
 */

import { nanoid } from 'nanoid'
import type { StoreApi } from 'zustand'
import type { FrameworkColorToken } from '@core/framework-schema'
import type { NodeTree, PageNode, StyleRule, SiteDocument } from '@core/page-tree'
import { addPage, createNode, reconcileSiteExplorerInPlace, reindexNodeParents } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { syncAllVCRefSlotInstances, allTreeNodeMaps, collectVCSlotOutletNames } from '../vcSlotReconcile'
import { create } from 'mutative'
import type { Draft, Patches } from 'mutative'
import type { ImportFragment } from '@core/htmlImport'
import type {
  NewStyleRule,
  ImportColorToken,
} from '@core/siteImport'
import { normalizeFrameworkColorSlug } from '@core/framework'
import { addImportedScripts, addImportedStylesheets } from './importedSiteFiles'
import type { EditorStore } from '@site/store/types'
import { MAX_HISTORY } from './defaults'
import { reconcileFrameworkClasses } from './framework/reconcile'
import { indexStyleRulesByName, linkImportedClassNames } from './importLinking'
import { addImportedFonts, addImportedFontTokens, addInstalledFontEntries, overwriteImportedFontTokens } from './importedFonts'
import type { HistoryEntry, SiteMutationResult, SiteSliceHelpers, SiteSliceRecipe, SuperImportHelpers } from './types'

/**
 * Compute a node's depth in a tree by walking the O(1) `parentId` pointer up
 * to the root — O(depth), no node-map scans. `parentId` is the engine's
 * denormalised parent cache (see `reindexNodeParents` / `getParent` in
 * `@core/page-tree`): restamped at every load boundary and maintained by every
 * tree mutation, so it is reliably consistent for any tree in the store.
 *
 * Used by `deleteNodes` to delete leaves before parents within a single batch
 * so descendants aren't double-removed (which would throw inside the helper).
 *
 * Returns 0 for the root, +Infinity for orphans — a `null` (or dangling)
 * `parentId` on a non-root node (sorts last in DESC order → effectively a
 * no-op when the orphan slot is reached).
 */
export function depthInTree(tree: NodeTree<PageNode>, nodeId: string): number {
  if (nodeId === tree.rootNodeId) return 0
  let current = nodeId
  let depth = 0
  const visited = new Set<string>()
  while (!visited.has(current)) {
    visited.add(current)
    const parentId = tree.nodes[current]?.parentId
    if (!parentId || !tree.nodes[parentId]) return Infinity
    depth++
    if (parentId === tree.rootNodeId) return depth
    current = parentId
  }
  return depth
}

/**
 * Resolve the tree the `mutateActiveTree*` helpers route to, from either the
 * frozen store state or a Mutative draft of it:
 *   - VC mode (`activeDocument.kind === 'visualComponent'`): the VC's tree,
 *     returned alongside the owning VisualComponent so callers can propagate
 *     slot-outlet changes.
 *   - Page mode (null or `kind === 'page'`): the active Page — Page IS
 *     NodeTree<PageNode>, so no conversion is needed (`vc` is null).
 *
 * This is the single implementation of the `kind === 'visualComponent'` tree
 * routing (CLAUDE.md §"Mutation API"). `deleteNodes` also calls it against the
 * frozen pre-mutation state to precompute deletion depths without touching
 * draft proxies.
 */
export function resolveActiveTreeTarget(
  state: Pick<EditorStore, 'site' | 'activeDocument' | 'activePageId'>,
): { tree: NodeTree<PageNode>; vc: VisualComponent | null } | null {
  const { site, activeDocument } = state
  if (!site) return null

  if (activeDocument?.kind === 'visualComponent') {
    const vc = site.visualComponents.find((v) => v.id === activeDocument.vcId)
    if (!vc) return null
    // VCNode is structurally compatible with PageNode (dynamicBindings is optional).
    return { tree: vc.tree as NodeTree<PageNode>, vc }
  }

  const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : state.activePageId
  const page = site.pages.find((p) => p.id === pageId)
  return page ? { tree: page, vc: null } : null
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Serialize a patch path so fold dedup can key on it. */
function patchPathKey(path: Patches[number]['path']): string {
  return JSON.stringify(path)
}

/**
 * Fold one coalesced keystroke's patch pair into the in-progress burst entry,
 * deduplicating by patch path: the entry holds AT MOST one inverse and one
 * forward patch per touched path, instead of accumulating 2K pairs (each
 * carrying the full prop value at that instant) over a K-keystroke burst.
 *
 *  - inverse (undo): the OLDEST patch per path wins — it restores the
 *    pre-burst value. Patches for newly-touched paths are prepended, keeping
 *    the previous newest-first replay order for hierarchically-overlapping
 *    paths.
 *  - forward (redo): the NEWEST value per path wins, but the stored patch
 *    keeps the op of the OLDEST forward patch: if the burst CREATED the prop,
 *    the folded patch stays 'add'-shaped so redo replays from the post-undo
 *    state where the prop is absent. Mutative's `apply` treats 'add' and
 *    'replace' identically for plain-object keys (verified against
 *    mutative@1.3.0 `src/apply.ts`, pinned by `historyCoalescingFold.test.ts`)
 *    — they differ only for array indices, which coalescing recipes never
 *    patch — so preserving the op is exactness, not necessity. When a
 *    'remove' op is involved on either side, the incoming patch replaces the
 *    stored one wholesale: deleting an absent object key is a no-op, so the
 *    newest patch already describes the burst's net effect for that path.
 *
 * Undo/redo results are bit-identical to the previous concat behavior —
 * replaying [newest…oldest] inverses leaves the oldest value per path, and
 * replaying [oldest…newest] forwards leaves the newest.
 */
function foldIntoCoalescedEntry(top: Draft<HistoryEntry>, entry: HistoryEntry): void {
  const knownInverse = new Set<string>()
  for (const p of top.inverse) knownInverse.add(patchPathKey(p.path))
  const freshInverse = entry.inverse.filter((p) => !knownInverse.has(patchPathKey(p.path)))
  if (freshInverse.length > 0) top.inverse = [...freshInverse, ...top.inverse]

  const forward = [...top.forward]
  const forwardIndexByPath = new Map<string, number>()
  forward.forEach((p, i) => forwardIndexByPath.set(patchPathKey(p.path), i))
  for (const incoming of entry.forward) {
    const key = patchPathKey(incoming.path)
    const i = forwardIndexByPath.get(key)
    if (i === undefined) {
      forwardIndexByPath.set(key, forward.length)
      forward.push(incoming)
      continue
    }
    const oldest = forward[i]!
    forward[i] =
      oldest.op === 'remove' || incoming.op === 'remove'
        ? incoming
        : { op: oldest.op, path: incoming.path, value: incoming.value }
  }
  top.forward = forward
}

function applyImportedBodyAttributes(
  rootNode: PageNode,
  fragment: ImportFragment,
  site: SiteDocument,
  byName: Map<string, string>,
): void {
  const body = fragment.body
  if (!body) return

  if (body.props && Object.keys(body.props).length > 0) {
    rootNode.props = { ...rootNode.props, ...body.props }
  }
  if (body.classIds?.length) {
    rootNode.classIds = linkImportedClassNames(body.classIds, site.styleRules, byName)
  }
  if (body.inlineStyles && Object.keys(body.inlineStyles).length > 0) {
    rootNode.inlineStyles = body.inlineStyles
  }
}

/**
 * Build the closure-shared helpers passed to every per-domain action factory.
 *
 * The `mutate*` helpers snapshot the current site before running the recipe,
 * then commit that snapshot to undo history only when the recipe reports a
 * semantic mutation. Recipes return `false` for explicit no-ops; `void` keeps
 * the historical default of "changed" so existing mutating recipes remain
 * concise. They differ only in what they hand the recipe:
 *
 *   - `mutateSite`:       the SiteDocument draft.
 *   - `mutateSiteState`:  the full editor-state draft plus the SiteDocument draft.
 *   - `mutateActiveTree`: the active NodeTree<PageNode>, routed by `activeDocument`.
 *
 * `resolveActiveTreeTarget` (above) is the SOLE implementation of the
 * `kind === 'visualComponent'` tree routing; `mutateActiveTree` is the only
 * mutation path through it — every named tree-mutation action delegates there.
 * Gated by `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`.
 */
export function buildSiteHelpers(
  set: (recipe: SiteSliceRecipe) => void,
  get: StoreApi<EditorStore>['getState'],
): SiteSliceHelpers {
  function recipeDidMutate(result: SiteMutationResult): boolean {
    return result !== false
  }

  /**
   * Commit one transaction's site-scoped patch pair to undo history.
   *
   * Coalescing: when the incoming key matches the in-progress burst, the entry
   * folds into the existing top entry instead of pushing a new one — deduped
   * by patch path via `foldIntoCoalescedEntry` (oldest inverse wins, newest
   * forward value wins), so a whole typing burst is one undo step holding at
   * most one patch pair per touched path.
   */
  function commitHistory(state: Draft<EditorStore>, entry: HistoryEntry): void {
    const coalescing =
      entry.coalesceKey !== null &&
      entry.coalesceKey === state._historyCoalesceKey &&
      state._historyPast.length > 0
    if (coalescing) {
      foldIntoCoalescedEntry(state._historyPast[state._historyPast.length - 1]!, entry)
      state._historyFuture = []
      state.canRedo = false
      return
    }

    state._historyPast.push(entry)
    if (state._historyPast.length > MAX_HISTORY) {
      state._historyPast.shift() // evict oldest
    }
    state._historyFuture = []
    // Open a new burst (coalesceKey set) or end any prior one (null).
    state._historyCoalesceKey = entry.coalesceKey
    state.canUndo = true
    state.canRedo = false
  }

  /**
   * Core of every undoable mutation. Runs `recipe` against a Mutative draft of
   * the WHOLE editor store with patch capture, then:
   *   - applies every changed top-level field to the live store, and
   *   - records ONLY the `site`-scoped patches in undo history.
   *
   * Editor-state fields a recipe touches (selection, runtime mirror, …) are
   * applied live but are NOT undoable — matching the prior snapshot model, which
   * only ever restored `site`. Capturing over the whole store (rather than just
   * `site`) is what lets `mutateSiteState` mutate editor state and the document
   * in one pass while keeping history `site`-only.
   *
   * Cost is O(change): Mutative only drafts/copies the paths the recipe touches,
   * so there is no full-site clone per mutation.
   */
  function runHistoricMutation(
    recipe: (draft: Draft<EditorStore>) => SiteMutationResult,
    coalesceKey: string | null,
  ): boolean {
    const cur = get()
    if (!cur.site) return false

    let result: SiteMutationResult = false
    const [next, patches, inverse] = create(
      cur,
      (draft) => {
        result = recipe(draft as Draft<EditorStore>)
        if (result !== false && draft.site) {
          draft.site.updatedAt = Date.now()
        }
      },
      { enablePatches: true },
    )
    if (result === false) return false

    const touched = new Set<string>()
    for (const p of patches) touched.add(String(p.path[0]))
    if (touched.size === 0) return true // non-false result but no actual change

    // History stores patches relative to `site` (strip the leading `'site'`
    // segment) so undo/redo can `apply(site, …)` directly.
    const siteForward: Patches = patches
      .filter((p) => p.path[0] === 'site')
      .map((p) => ({ ...p, path: p.path.slice(1) }))
    const siteInverse: Patches = inverse
      .filter((p) => p.path[0] === 'site')
      .map((p) => ({ ...p, path: p.path.slice(1) }))

    set((state) => {
      // Apply every changed top-level field (site + any editor fields) from the
      // produced `next` onto the live draft. Each is a structurally-shared new
      // object, so this is a cheap reference copy, not a deep clone.
      const live = state as unknown as Record<string, unknown>
      const produced = next as unknown as Record<string, unknown>
      for (const key of touched) live[key] = produced[key]

      if (siteForward.length > 0) {
        commitHistory(state, { inverse: siteInverse, forward: siteForward, coalesceKey })
      }
      state.hasUnsavedChanges = true
    })
    return true
  }

  /**
   * Shared recipe core for `mutateActiveTree` / `mutateActiveTreeAndSite`.
   *
   * Routes to the active tree via `resolveActiveTreeTarget`, runs `fn`, and —
   * in VC mode — propagates any change in the VC's slot-outlet set to every
   * consumer VC ref, across all pages AND every other VC's tree (refs nested
   * inside other VCs, ISS-026), via `syncAllVCRefSlotInstances`. The sweep
   * runs INSIDE the recipe so those writes land in the same patch set.
   *
   * The sweep is GATED on an actual change of the VC's ordered slot-outlet
   * name sequence: the pre-mutation sequence is read from the frozen store
   * state (cheap — no draft proxies), the post-mutation sequence from the
   * VC-tree-sized draft. That sequence is the ONLY input `syncSlotInstances`
   * reads from the VC, so an unchanged sequence makes the sweep a guaranteed
   * no-op — and running it anyway rewrites every consumer ref's `children`
   * array, turning each per-keystroke VC prop edit into a site-wide sweep.
   * Gating on the ordered sequence (not the name SET) keeps outlet reorders
   * propagating, since slot-instance order follows outlet order.
   */
  function runActiveTreeRecipe(
    draft: Draft<EditorStore>,
    fn: (tree: NodeTree<PageNode>) => SiteMutationResult,
  ): SiteMutationResult {
    const target = resolveActiveTreeTarget(draft)
    if (!target) return false
    const { tree, vc } = target
    if (!vc) return fn(tree)

    // `get()` is the frozen pre-mutation state — the VC is guaranteed present
    // there because the draft (where it was just found) mirrors it.
    const frozenVc = get().site?.visualComponents.find((v) => v.id === vc.id)
    const outletNamesBefore = frozenVc ? collectVCSlotOutletNames(frozenVc.tree) : null

    const result = fn(tree)
    if (result === false) return false

    const outletNamesAfter = collectVCSlotOutletNames(vc.tree)
    if (outletNamesBefore === null || !stringArraysEqual(outletNamesBefore, outletNamesAfter)) {
      syncAllVCRefSlotInstances(allTreeNodeMaps(draft.site!), vc.id, vc)
    }
    return result
  }

  /**
   * Mutate the active node tree — auto-records undo history on real changes.
   *
   * Routes based on `activeDocument` (see `resolveActiveTreeTarget`):
   *   - Page mode (null or kind === 'page'): passes the active Page directly —
   *     Page IS NodeTree<PageNode> so no conversion needed.
   *   - VC mode (kind === 'visualComponent'): passes vc.tree directly, then
   *     propagates slot-outlet changes to every consumer VC ref when the
   *     outlet sequence changed (see `runActiveTreeRecipe`).
   */
  function mutateActiveTree(
    fn: (tree: NodeTree<PageNode>) => SiteMutationResult,
    opts?: { coalesceKey?: string },
  ): boolean {
    return runHistoricMutation((draft) => runActiveTreeRecipe(draft, fn), opts?.coalesceKey ?? null)
  }

  /** Mutate the site — auto-records undo history on real changes. */
  function mutateSite(
    fn: (site: SiteDocument) => SiteMutationResult,
    opts?: { coalesceKey?: string },
  ): boolean {
    return runHistoricMutation((draft) => fn(draft.site!), opts?.coalesceKey ?? null)
  }

  const mutateSiteWithExplorerReconcile: SiteSliceHelpers['mutateSiteWithExplorerReconcile'] = (fn) =>
    mutateSite((site) => {
      const result = fn(site)
      if (!recipeDidMutate(result)) return false
      reconcileSiteExplorerInPlace(site)
      return result
    })

  /**
   * Mutate editor state and site together — records undo history on real
   * changes. The recipe gets the full editor draft plus the SiteDocument draft;
   * site changes are undoable, editor-state changes are applied live only
   * (parity with the prior snapshot model — see `runHistoricMutation`).
   */
  const mutateSiteState: SiteSliceHelpers['mutateSiteState'] = (fn) =>
    runHistoricMutation((draft) => fn(draft, draft.site!), null)

  /**
   * Mutate the active node tree AND the surrounding site — records undo history
   * on real changes. Same routing and slot-outlet propagation contract as
   * `mutateActiveTree` (shared via `runActiveTreeRecipe`), but also hands the
   * recipe a `SiteDocument` draft so it can read or write site-level state
   * alongside the tree mutation in one transaction.
   *
   * Used by duplicate operations that must clone scoped classes (which live
   * on `site.styleRules`) atomically with the node duplication. Without this
   * the duplicate's `classIds` would point at the source's scoped classes,
   * silently coupling per-node CSS across both nodes.
   */
  function mutateActiveTreeAndSite(
    fn: (tree: NodeTree<PageNode>, site: SiteDocument) => SiteMutationResult,
  ): boolean {
    return runHistoricMutation(
      (draft) => runActiveTreeRecipe(draft, (tree) => fn(tree, draft.site!)),
      null,
    )
  }

  /**
   * Mutate the entire site — all pages and style rules — in ONE undoable
   * history snapshot. The recipe receives a SiteDocument draft and transaction
   * helpers for adding or overwriting pages and style rules.
   *
   * Class names on imported fragment nodes are resolved to registry ids (and
   * unknown names auto-create bare classes) via the shared `byName` map that
   * the helpers build once and share across the whole recipe. This guarantees
   * that a class added by `addStyleRule` earlier in the recipe is reused by
   * `addPage` later in the same recipe — no duplicate rules for the same name.
   *
   * A history snapshot is pushed ONLY when the recipe returns a non-false
   * result AND at least one helper actually mutated the site. Explicit no-ops
   * (`return false`) never produce a history entry.
   */
  function mutateAllPagesAndSite(
    fn: (site: SiteDocument, helpers: SuperImportHelpers) => SiteMutationResult,
  ): boolean {
    return runHistoricMutation((draft) => {
      const site = draft.site!
      let didMutate = false

      // Build the name→id index once. All helpers share this map so that
      // a `addStyleRule(kind:'class', name:'btn')` followed by
      // `addPage(fragment with node.classIds:['btn'])` resolves to the same id.
      const byName = indexStyleRulesByName(site.styleRules)

      const helpers: SuperImportHelpers = {
        addPage({ id: pageId, title, slug, nodeFragment }: { id?: string; title: string; slug: string; nodeFragment: ImportFragment }): string {
          // addPage creates a fresh base.body root, normalises the slug, and
          // pushes the page onto site.pages. We then graft the fragment nodes
          // in as children of that root — same logical step as insertImportedNodes.
          const page = addPage(site as SiteDocument, title, slug)
          // Honour a caller-supplied id so the importer can pre-mint page ids
          // and rewrite internal links to `cms:page:<id>` before committing.
          if (pageId) page.id = pageId
          applyImportedBodyAttributes(page.nodes[page.rootNodeId]!, nodeFragment, site, byName)
          for (const [id, node] of Object.entries(nodeFragment.nodes)) {
            // `node.inlineStyles` rides along on the spread — first-class field.
            page.nodes[id] = {
              ...node,
              classIds: linkImportedClassNames(node.classIds, site.styleRules, byName),
            }
          }
          page.nodes[page.rootNodeId]!.children = [...nodeFragment.rootIds]
          reindexNodeParents(page.nodes)
          didMutate = true
          return page.id
        },

        addStyleRule(rule: NewStyleRule): string {
          const id = nanoid()
          const now = Date.now()
          // Append after every existing rule so imports don't disrupt the
          // established cascade order.
          let maxOrder = -1
          for (const r of Object.values(site.styleRules)) {
            if (typeof r.order === 'number' && r.order > maxOrder) maxOrder = r.order
          }
          const newRule: StyleRule = {
            ...rule,
            id,
            createdAt: now,
            updatedAt: now,
            order: maxOrder + 1,
          }
          site.styleRules[id] = newRule
          // Register in byName so subsequent addPage calls referencing this
          // class name resolve to this id rather than creating a duplicate.
          if (rule.kind === 'class') byName.set(rule.name, id)
          didMutate = true
          return id
        },

        overwritePage(pageId: string, { title, slug, nodeFragment }: { title: string; slug: string; nodeFragment: ImportFragment }): void {
          const page = site.pages.find((p) => p.id === pageId)
          if (!page) throw new Error('overwritePage: page not found')

          // Mint a fresh body root; wire fragment roots as its children.
          const rootNode = createNode('base.body')
          rootNode.children = [...nodeFragment.rootIds]
          applyImportedBodyAttributes(rootNode, nodeFragment, site, byName)

          const newNodes: Record<string, PageNode> = { [rootNode.id]: rootNode }
          for (const [id, node] of Object.entries(nodeFragment.nodes)) {
            newNodes[id] = {
              ...node,
              classIds: linkImportedClassNames(node.classIds, site.styleRules, byName),
            }
          }

          // Replace tree fields; preserve identity + ownership fields.
          reindexNodeParents(newNodes)
          page.rootNodeId = rootNode.id
          page.nodes = newNodes
          page.title = title
          page.slug = slug
          didMutate = true
        },

        overwriteStyleRule(ruleId: string, rule: NewStyleRule): void {
          const existing = site.styleRules[ruleId]
          if (!existing) throw new Error('overwriteStyleRule: style rule not found')

          const now = Date.now()
          // Replace all fields except identity + cascade position.
          site.styleRules[ruleId] = {
            ...rule,
            id: ruleId,
            createdAt: existing.createdAt,
            updatedAt: now,
            order: existing.order,
          }
          if (rule.kind === 'class') byName.set(rule.name, ruleId)
          didMutate = true
        },

        addConditions(conditions): void {
          if (conditions.length === 0) return
          if (!site.conditions) site.conditions = []
          const existing = new Set(site.conditions.map((c) => c.id))
          for (const def of conditions) {
            if (existing.has(def.id)) continue
            existing.add(def.id)
            site.conditions.push(def)
            didMutate = true
          }
        },

        addFonts(fonts): { id: string; family: string }[] {
          const committed = addImportedFonts(site, fonts)
          if (committed.length > 0) didMutate = true
          return committed
        },

        addInstalledFonts(fonts): { id: string; family: string }[] {
          const committed = addInstalledFontEntries(site, fonts)
          if (committed.length > 0) didMutate = true
          return committed
        },

        addFontTokens(tokens): { id: string; name: string; variable: string }[] {
          const committed = addImportedFontTokens(site, tokens)
          if (committed.length > 0) didMutate = true
          return committed
        },

        overwriteFontTokens(items): { id: string; name: string; variable: string }[] {
          const committed = overwriteImportedFontTokens(site, items)
          if (committed.length > 0) didMutate = true
          return committed
        },

        addColorTokens(colors): { slug: string; value: string }[] {
          const committed = addImportedColorTokens(site, colors)
          if (committed.length > 0) {
            reconcileFrameworkClasses(site)
            didMutate = true
          }
          return committed
        },

        overwriteColorTokens(items): { slug: string; value: string }[] {
          const committed = overwriteImportedColorTokens(site, items)
          if (committed.length > 0) {
            reconcileFrameworkClasses(site)
            didMutate = true
          }
          return committed
        },

        addScripts(scripts): { id: string; path: string }[] {
          const committed = addImportedScripts(site, draft.siteRuntime, scripts)
          if (committed.length > 0) didMutate = true
          return committed
        },

        addStylesheets(stylesheets): { id: string; path: string }[] {
          const committed = addImportedStylesheets(site, draft.siteRuntime, stylesheets)
          if (committed.length > 0) didMutate = true
          return committed
        },
      }

      const result = fn(site as SiteDocument, helpers)
      // Push history only when the recipe reported a change AND a helper
      // actually mutated the site — `runHistoricMutation` treats `false` as a
      // no-op (no patches captured, no history entry).
      return recipeDidMutate(result) && didMutate ? true : false
    }, null)
  }

  return {
    set,
    get,
    mutateActiveTree,
    mutateActiveTreeAndSite,
    mutateSite,
    mutateSiteWithExplorerReconcile,
    mutateSiteState,
    mutateAllPagesAndSite,
  }
}

/**
 * Merge imported colour tokens into `site.settings.framework.colors` as PLAIN
 * BASE tokens — each emits only `--<slug>` (no shades/tints/transparent variants
 * and no `bg-/text-/border-` utility classes), so the palette is a faithful 1:1
 * of the source `:root` and every imported `var(--<slug>)` keeps resolving.
 *
 * A slug already present in the framework (case/format-normalised) is skipped:
 * the existing token wins, mirroring the class-conflict "first wins" rule.
 *
 * @returns The committed `{ slug, value }` for each newly-added token.
 */
function addImportedColorTokens(
  site: Draft<SiteDocument>,
  colors: ImportColorToken[],
): { slug: string; value: string }[] {
  if (colors.length === 0) return []

  // Ensure the framework colours container exists (enabling the framework).
  site.settings.framework ??= { colors: { tokens: [] } }
  site.settings.framework.colors ??= { tokens: [] }
  const tokens = site.settings.framework.colors.tokens

  const existingSlugs = new Set(tokens.map((t) => normalizeFrameworkColorSlug(t.slug)))
  let maxOrder = tokens.reduce((m, t) => Math.max(m, t.order ?? 0), -1)
  const committed: { slug: string; value: string }[] = []

  for (const { slug: rawSlug, value } of colors) {
    const slug = normalizeFrameworkColorSlug(rawSlug)
    if (existingSlugs.has(slug)) continue
    existingSlugs.add(slug)
    const now = Date.now()
    const token: FrameworkColorToken = {
      id: nanoid(),
      category: '',
      slug,
      lightValue: value,
      darkValue: '',
      darkModeEnabled: false,
      generateUtilities: { text: false, background: false, border: false, fill: false },
      generateTransparent: false,
      generateShades: { enabled: false, count: 0 },
      generateTints: { enabled: false, count: 0 },
      order: (maxOrder += 1),
      createdAt: now,
      updatedAt: now,
    }
    tokens.push(token)
    committed.push({ slug, value })
  }

  return committed
}

/**
 * Overwrite existing framework colour tokens in place (import conflict:
 * overwrite). The existing token's id, slug, and generation flags are retained;
 * only its `lightValue` is replaced, so `var(--<slug>)` references on both the
 * existing and imported sides keep resolving to the new colour.
 *
 * @returns The `{ slug, value }` for each overwritten token.
 */
function overwriteImportedColorTokens(
  site: Draft<SiteDocument>,
  items: { existingTokenId: string; value: string }[],
): { slug: string; value: string }[] {
  if (items.length === 0) return []

  const tokens = site.settings.framework?.colors?.tokens
  if (!tokens || tokens.length === 0) return []

  const committed: { slug: string; value: string }[] = []
  for (const { existingTokenId, value } of items) {
    const existing = tokens.find((t) => t.id === existingTokenId)
    if (!existing) continue
    existing.lightValue = value
    existing.updatedAt = Date.now()
    committed.push({ slug: existing.slug, value })
  }

  return committed
}

