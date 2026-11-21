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
 * @see src/core/siteImport/commitPlan.ts — `commitImportPlan`
 * @see src/admin/modals/SiteImport/shared/createSiteImportAdapter.ts — admin-side adapter implementation
 */

import type {
  NewStyleRule,
  ImportFontFamily,
  GoogleFontRequest,
  ImportColorToken,
  ImportFontToken,
  ImportScript,
  ImportStylesheet,
  UploadedImportAsset,
} from './types'
import type { ImportWarning } from './warnings'
import type { ConditionDef, PageSeo } from '@core/page-tree'
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
   * `altText` is the authored `<img alt>` for the file (when any page gave it
   * one) — the record is created with it, since the library owns alt text.
   * `signal` is the run's cancellation signal — implementations forward it to
   * the underlying request so cancelling the wizard aborts the in-flight
   * upload instead of only skipping the queued ones.
   *
   * Resolves once the bytes are in the library with their final public URL
   * (e.g. `"/uploads/abc123.png"` or `"https://cdn.example.com/..."`).
   * Anything best-effort around the upload — folder placement — must not
   * reject; it is reported through `warnings` so the URL rewrite still runs.
   */
  uploadAsset(file: {
    path: string
    bytes: Uint8Array
    mimeType: string
    altText?: string
    signal?: AbortSignal
  }): Promise<UploadedImportAsset>

  /**
   * Install a Google font request extracted from a trusted CSS2 @import.
   *
   * Implementations should call the same CMS Google-font install endpoint used
   * by the Typography panel. This returns a fully-shaped FontEntry but does not
   * mutate the site; the entry is merged by `tx.addInstalledFonts` inside the
   * single import transaction.
   */
  installGoogleFont(font: GoogleFontRequest): Promise<FontEntry>

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
 * inside a single `mutateActiveTreeAndSite` Mutative recipe.
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
    /** The page's head settings read from its `<head>`; null for none. */
    seo: PageSeo | null
  }): string

  /**
   * Overwrite the content of an existing page (conflict: overwrite resolution).
   *
   * The existing page's id is retained; its title, slug, node tree and head
   * settings are replaced by the imported page's. Class name→id linking
   * applies identically to `addPage`.
   */
  overwritePage(
    pageId: string,
    input: {
      title: string
      slug: string
      nodeFragment: ImportFragment
      seo: PageSeo | null
    },
  ): void

  /**
   * Put a style rule into the site's global registry: add it — or, when the
   * registry already holds the rule this import is delivering again (same
   * `origin` and selector), replace that rule in place, keeping its id and
   * cascade order. That is what makes importing the same site twice a no-op
   * for its ambient rules.
   *
   * @returns The rule's id (fresh, or the replaced rule's).
   */
  putStyleRule(rule: NewStyleRule): string

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
   * Add stylesheets that import as files: one `SiteFile` (`type: 'style'`)
   * per sheet plus a `site.runtime.styles` entry. A kept linked sheet
   * (`mode: 'file'`) is scoped to the pages that linked it; a sheet no page
   * linked carries no `pageIds` and applies to every page.
   *
   * @returns The committed `{ id, path }` for each added stylesheet.
   */
  addStylesheets(stylesheets: ImportStylesheet[]): { id: string; path: string }[]

  /**
   * Keep existing script / stylesheet files an import delivers again (a
   * `FileConflict` resolved to `skip` or `overwrite`). Each file keeps its id,
   * path and load order. `replacement`, when given (overwrite), brings the
   * imported content, a script's format, a fresh `importRecord`, and a
   * script's npm packages: a pinned version the script now asks for replaces
   * the listed one, unless that would loosen a pin, another script outside
   * the replacement still imports the package, or two replacements disagree;
   * then the listed version stays and a `dependency-version-kept` warning
   * says so. The pages in `pageIds` join a page-scoped file's runtime scope;
   * an empty `pageIds` (a site-wide sheet) widens it to every page.
   *
   * @returns `{ id, path }` for each reused file still in the site, and the
   *          warnings raised.
   */
  reuseSiteFiles(
    items: { existingFileId: string; pageIds: string[]; replacement?: ImportScript | ImportStylesheet }[],
  ): { files: { id: string; path: string }[]; warnings: ImportWarning[] }

  /**
   * Merge this import's files of one kind into the site's load order
   * (`mergeImportOrder`) and renumber priorities as little as that order
   * allows (`prioritiesForOrder`). `importOrder` lists the import's files
   * (added, replaced, reused) by id in the import's own order; `addedIds`
   * are the ones this import just added, which have no place in the site's
   * order yet.
   */
  orderImportedFiles(kind: 'script' | 'style', importOrder: string[], addedIds: string[]): void
}
