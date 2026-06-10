/**
 * SiteImportAdapter and SiteImportTransaction — the headless contract between
 * the import pipeline (Phase 2) and the admin-side store (Phase 3).
 *
 * The headless pipeline (`commitImportPlan`) calls the adapter to:
 *   1. Upload asset bytes and receive back media-library URLs.
 *   2. Commit all page and style-rule additions in a single atomic transaction.
 *
 * The admin-side adapter (implemented in Phase 3) wraps the Zustand store
 * mutations and the server-side asset upload endpoint.
 *
 * This file is intentionally interface-only — no implementation here.
 *
 * @see src/core/siteImport/applyImport.ts — `commitImportPlan` caller
 * @see src/admin/...   — Phase 3 adapter implementation (TBD)
 */

import type {
  NewStyleRule,
  ImportFontFamily,
  ImportGoogleFont,
  ImportColorToken,
  ImportFontToken,
  ImportScript,
  ImportStylesheet,
} from './types'
import type { ConditionDef } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'
import type { FontEntry } from '@core/fonts'

// ---------------------------------------------------------------------------
// SiteImportAdapter
// ---------------------------------------------------------------------------

/**
 * Top-level adapter that the Phase 3 wizard implements and passes to
 * `commitImportPlan`.
 */
export interface SiteImportAdapter {
  /**
   * Upload a single asset to the media library.
   *
   * @returns The public media URL the page tree should reference (e.g.
   *          `"/uploads/abc123.png"` or `"https://cdn.example.com/..."`).
   */
  uploadAsset(file: { path: string; bytes: Uint8Array; mimeType: string }): Promise<string>

  /**
   * Install a Google font request extracted from a trusted CSS2 @import.
   *
   * Implementations should call the same CMS Google-font install endpoint used
   * by the Typography panel. This returns a fully-shaped FontEntry but does not
   * mutate the site; the entry is merged by `tx.addInstalledFonts` inside the
   * single import transaction.
   */
  installGoogleFont(font: ImportGoogleFont): Promise<FontEntry>

  /**
   * Execute all page and style-rule mutations in a single atomic step.
   *
   * The callback receives a `SiteImportTransaction` and must call its methods
   * (in any order) to describe the changes. The adapter implements the
   * callback inside a single undo-history snapshot so that Cmd+Z reverts the
   * entire import in one step.
   *
   * The callback is synchronous — all data is already available at call time
   * (assets have been uploaded; URLs have been rewritten in the plan).
   */
  commit(recipe: (tx: SiteImportTransaction) => void): Promise<void>
}

// ---------------------------------------------------------------------------
// SiteImportTransaction
// ---------------------------------------------------------------------------

/**
 * Passed to `SiteImportAdapter.commit`'s callback.
 *
 * Each method corresponds to one mutation operation. The admin-side
 * implementation (`Phase 3`) maps these directly to Zustand store mutations
 * inside a single `mutateActiveTreeAndSite` Immer producer.
 */
export interface SiteImportTransaction {
  /**
   * Add a new page with the given title, slug, and body content.
   *
   * The `nodeFragment` contains class *names* (not ids) on node.classIds, as
   * produced by `importHtml`. The implementer is responsible for reconciling
   * those names to registry class ids — creating bare (style-less) classes for
   * unknown names — exactly as `insertImportedNodes` does. See
   * `src/admin/pages/site/store/slices/site/nodeActions.ts` for the reference
   * implementation of the name→id linking step.
   *
   * @returns The new page's id. When `input.id` is provided it is used
   *          verbatim (so the importer can pre-mint ids and rewrite internal
   *          links to `cms:page:<id>` before committing); otherwise a fresh id
   *          is generated.
   */
  addPage(input: {
    /** Pre-minted page id. When omitted, the implementer generates one. */
    id?: string
    title: string
    slug: string
    nodeFragment: ImportFragment
  }): string

  /**
   * Overwrite the content of an existing page (conflict: overwrite resolution).
   *
   * The existing page's id, slug, and title are retained; only the node tree
   * is replaced with the imported fragment. Class name→id linking applies
   * identically to `addPage`.
   */
  overwritePage(
    pageId: string,
    input: {
      title: string
      slug: string
      nodeFragment: ImportFragment
    },
  ): void

  /**
   * Add a new style rule to the site's global registry.
   *
   * @returns The new rule's generated id.
   */
  addStyleRule(rule: NewStyleRule): string

  /**
   * Overwrite an existing style rule (conflict: overwrite resolution).
   *
   * The existing rule's id is retained; all other fields are replaced by the
   * imported rule's values.
   */
  overwriteStyleRule(ruleId: string, rule: NewStyleRule): void

  /**
   * Merge reusable conditions into the site-level `site.conditions` registry,
   * deduped by id. Imported rules reference these via their `contextStyles`
   * keys, so they must be committed alongside the rules.
   */
  addConditions(conditions: ConditionDef[]): void

  /**
   * Add custom font families (from imported `@font-face` blocks) to
   * `site.settings.fonts`. Each file's `src` is already a final media URL.
   *
   * @returns The committed `{ id, family }` for each added font, for the
   *          import summary.
   */
  addFonts(fonts: ImportFontFamily[]): { id: string; family: string }[]

  /**
   * Merge already-installed font entries into `site.settings.fonts`. Used for
   * Google CSS2 imports after the adapter has downloaded them through the CMS
   * Google-font installer.
   */
  addInstalledFonts(fonts: FontEntry[]): { id: string; family: string }[]

  /**
   * Add font tokens extracted from root `--font-*` variables. Called after
   * `addFonts`, so tokens whose source stack names an imported family can bind
   * to the newly committed family id.
   *
   * @returns The committed `{ id, name, variable }` for each newly-added token.
   */
  addFontTokens(tokens: ImportFontToken[]): { id: string; name: string; variable: string }[]

  /**
   * Overwrite existing font tokens in place (conflict: overwrite resolution).
   * The existing token's id, name, and variable are retained; its family
   * binding and fallback stack are replaced from the imported token, so every
   * `var(--<variable>)` reference (on both the existing and imported sides)
   * keeps resolving to the new value.
   *
   * @returns The `{ id, name, variable }` for each overwritten token.
   */
  overwriteFontTokens(
    items: { existingTokenId: string; token: ImportFontToken }[],
  ): { id: string; name: string; variable: string }[]

  /**
   * Add colour tokens (extracted from root-scope `--*` colour custom properties)
   * to the CMS colours system (`site.settings.framework.colors`). Each becomes a
   * plain base token that re-emits `--<slug>`, so imported `var(--<slug>)`
   * references keep resolving. A slug already present in the framework is
   * skipped (the existing token wins).
   *
   * @returns The committed `{ slug, value }` for each newly-added token.
   */
  addColorTokens(colors: ImportColorToken[]): { slug: string; value: string }[]

  /**
   * Overwrite existing colour tokens in place (conflict: overwrite resolution).
   * The existing token's id and slug are retained; only its colour value is
   * replaced, so `var(--<slug>)` references on both sides keep resolving.
   *
   * @returns The `{ slug, value }` for each overwritten token.
   */
  overwriteColorTokens(
    items: { existingTokenId: string; value: string }[],
  ): { slug: string; value: string }[]

  /**
   * Add imported JavaScript files as site scripts: one `SiteFile`
   * (`type: 'script'`) per file plus a page-scoped `site.runtime.scripts`
   * entry so each runs where the source HTML linked it.
   *
   * @returns The committed `{ id, path }` for each added script.
   */
  addScripts(scripts: ImportScript[]): { id: string; path: string }[]

  /**
   * Add stylesheets kept as files (`mode: 'file'`): one `SiteFile`
   * (`type: 'style'`) per sheet plus a page-scoped `site.runtime.styles`
   * entry so each applies exactly where the source HTML linked it.
   *
   * @returns The committed `{ id, path }` for each added stylesheet.
   */
  addStylesheets(stylesheets: ImportStylesheet[]): { id: string; path: string }[]
}
