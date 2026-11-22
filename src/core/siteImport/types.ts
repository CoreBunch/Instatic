/**
 * Shared types for the Super Import pipeline (Phase 1+).
 *
 * These types are headless — no admin/React/server imports allowed here.
 * @see src/__tests__/architecture/siteImport-headless.test.ts
 */

import type { StyleRule, ConditionDef, PageSeo } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'
import type { FontDisplay, FontFileFormat } from '@core/fonts'
import type { SiteScriptFormat, SiteScriptPlacement } from '@core/site-runtime'
import type { ImportWarning } from './warnings'
import type {
  PageConflict,
  RuleConflict,
  TokenConflict,
  CrossSheetClassConflict,
  FileConflict,
  MediaConflict,
} from './conflictTypes'

// ---------------------------------------------------------------------------
// NewStyleRule — a StyleRule ready to insert (sans identity fields)
// ---------------------------------------------------------------------------

/**
 * A fully-specified style rule that can be committed to the site's styleRules
 * registry. The identity fields (`id`, `createdAt`, `updatedAt`) are assigned
 * by the caller (Phase 2's `applyImport.ts`) when writing to the store, not
 * by the parser.
 */
export type NewStyleRule = Omit<StyleRule, 'id' | 'createdAt' | 'updatedAt'>

// ---------------------------------------------------------------------------
// BreakpointHint — how @media queries map to named viewport contexts
// ---------------------------------------------------------------------------

/**
 * A hint that maps a named viewport context to its CSS media query and pixel
 * frame width. Passed to `cssToStyleRules` so @media queries can be matched to
 * existing site viewport contexts by configured query first, then by
 * max-width threshold (±mediaTolerance) for older/default contexts.
 */
export interface BreakpointHint {
  /** Viewport context identifier, matching a context key used in `StyleRule.contextStyles`. */
  id: string
  /** The frame width in CSS pixels (e.g. 768 for a tablet viewport). */
  width: number
  /** The configured CSS media query for this viewport context. */
  mediaQuery?: string
}

// ---------------------------------------------------------------------------
// AssetRef — records a url(...) reference found in an imported rule
// ---------------------------------------------------------------------------

/**
 * A URL reference found inside a CSS declaration value.
 *
 * The parser records these but does NOT modify the rule's declaration value.
 * Phase 2 (`applyImport.ts`) rewrites the URLs once assets have been uploaded
 * and their final media-library paths are known.
 *
 * NOTE: Only references inside emitted or captured rules are recorded. A
 * `url()` inside a dropped @-rule does not appear in `assetRefs` because the
 * rule was never emitted.
 */
export interface AssetRef {
  /** Zero-based index into `CssToStyleRulesResult.rules`. */
  ruleIndex: number
  /**
   * The editing-context id this declaration lives in (a viewport context id or
   * a custom-condition id — both keys into `StyleRule.contextStyles`), or
   * `undefined` for the rule's base `styles` object. When set, the rewriters
   * target that context's override bag rather than base.
   */
  contextId?: string
  /** True when the reference lives inside a rule's `rawCss` block. */
  rawCss?: boolean
  /** camelCase CSS property name (e.g. `backgroundImage`). */
  property: string
  /**
   * The raw URL payload — unquoted and untrimmed. For `url('assets/bg.png')`
   * this is `assets/bg.png`.
   */
  rawUrl: string
}

// ---------------------------------------------------------------------------
// @font-face import types
// ---------------------------------------------------------------------------

/**
 * One `@font-face` block captured verbatim by the CSS parser, before asset
 * resolution. `srcUrls` are the raw `url(...)` payloads (a single face may list
 * several fallback formats); `variant` is the canonical weight/style derived
 * from the `font-weight` + `font-style` descriptors.
 */
export interface ParsedFontFace {
  family: string
  /** Canonical variant tag — "400", "700italic", … */
  variant: string
  /** Raw `url(...)` payloads from the `src` descriptor, in source order. */
  srcUrls: string[]
  unicodeRange?: string
  fontDisplay?: FontDisplay
}

/**
 * One resolved font file ready to become a `FontFile`. `src` holds a FileMap
 * key before `applyAssetRewrites` runs, and the rewritten media URL after.
 */
export interface ImportFontFile {
  variant: string
  format: FontFileFormat
  /** FileMap key (pre-rewrite) → media public URL (post-rewrite). */
  src: string
  unicodeRange?: string
  fontDisplay?: FontDisplay
}

/** A custom font family synthesized from imported `@font-face` blocks. */
export interface ImportFontFamily {
  family: string
  files: ImportFontFile[]
}

/**
 * A Google Fonts CSS2 family request extracted from a trusted
 * `fonts.googleapis.com/css2` @import. Commit resolves these through the same
 * CMS Google-font installer used by the Typography panel, producing self-hosted
 * font entries instead of leaving an external stylesheet in the site.
 */
export interface GoogleFontRequest {
  family: string
  variants: string[]
  subsets: string[]
}

/** A planned Google font: the install request plus where the import asked for it. */
export interface ImportGoogleFont extends GoogleFontRequest {
  /** Converted CSS (rules from linked sheets, inline `<style>`) requests it. */
  requestedByConvertedCss: boolean
  /** `ImportStylesheet.path` of every stylesheet file whose `@import` requests it. */
  stylesheetPaths: string[]
}

/**
 * A colour-valued custom property pulled from a root-scope rule (`:root`,
 * `html`, `body`). Committed into the CMS colours system
 * (`site.settings.framework.colors`) as a plain base token that re-emits
 * `--<slug>`. See `colorTokens.ts`.
 */
export interface ImportColorToken {
  /** CSS-variable name without the leading `--` (e.g. `bg`). */
  slug: string
  /** The authored colour value, verbatim and trimmed (e.g. `#0a0a0a`). */
  value: string
}

/**
 * A root-scope `--font-*` custom property pulled from imported CSS. Committed
 * into `site.settings.fonts.tokens` so `font-family: var(--font-body)` keeps
 * resolving through the builder's editable font-token model.
 */
export interface ImportFontToken {
  /** User-facing token name derived from the variable, e.g. `font-display` → `Display`. */
  name: string
  /** CSS-variable name without leading dashes, normalized to `font-*`. */
  variable: string
  /** First concrete family in the source stack, if present. */
  family?: string
  /** Remaining fallback stack, or the whole stack for system/generic tokens. */
  fallback: string
}

/**
 * An npm package required by an imported runtime module script.
 *
 * Super Import derives these when a source script imports an ESM CDN URL that
 * maps cleanly to an npm package, then rewrites that import to the bare package
 * specifier so the normal self-hosted dependency resolver can install it.
 */
export interface ImportScriptDependency {
  name: string
  version: string
}

/**
 * A JavaScript file linked by one or more imported HTML pages. Committed as a
 * `SiteFile` (`type: 'script'`) plus page-scoped `site.runtime.scripts` entry.
 * `content` is the decoded UTF-8 source.
 */
export interface ImportScript {
  /** FileMap path of the source file (e.g. `scripts/app.js`). */
  path: string
  /** Decoded UTF-8 JavaScript source. */
  content: string
  /** Loader semantics from the source HTML. Classic scripts bypass bundling. */
  format: SiteScriptFormat
  /** `'head'` only when every page runs it as a blocking `<head>` script. */
  placement: SiteScriptPlacement
  /** HTML FileMap sources that linked this script. */
  pageSources: string[]
  /** Final committed page IDs. Filled by `commitImportPlan` before adapter call. */
  pageIds?: string[]
  /**
   * SHA-256 of the text as the bundle had it, before asset URLs were
   * rewritten. Filled by `commitImportPlan`; the store keeps it in the site
   * file's `importRecord`.
   */
  sourceHash?: string
  /**
   * Runtime ordering; lower runs earlier. One number per script, so it is
   * derived from EVERY page's document order at once (`scriptOrder.ts`): a
   * script shared by two pages sits after whatever either page loads before
   * it. Contradictory page orders surface as `script-order-conflict`.
   */
  priority: number
  /** npm dependencies needed by this module script after import conversion. */
  dependencies?: ImportScriptDependency[]
}

/**
 * How one top-level linked stylesheet imports.
 *
 * - `'convert'` (default): the sheet is parsed into editable style rules —
 *   class rules become registry classes, ambient rules, `@keyframes`, colour /
 *   font token extraction. Converted rules merge into the site's one global
 *   cascade, CSS-natively.
 * - `'file'`: the sheet's CSS text imports verbatim (minus asset-URL
 *   rewriting) as a `SiteFile` (`type: 'style'`) scoped to exactly the pages
 *   that linked it via `site.runtime.styles`. No selector rewriting, no
 *   generated scope classes — the file is the single source of truth, so
 *   semantic extraction (rules, tokens, keyframes) is skipped for it.
 */
export type StylesheetImportMode = 'convert' | 'file'

/**
 * One top-level stylesheet linked by ≥1 imported page, as presented in the
 * wizard's Review step. `mode` reflects the caller-chosen import mode this
 * plan was built with (default `'convert'`).
 */
export interface LinkedStylesheet {
  /** FileMap path of the `<link rel="stylesheet">` target. */
  path: string
  mode: StylesheetImportMode
  /** HTML FileMap sources that link this stylesheet. */
  pageSources: string[]
}

/**
 * A stylesheet imported as a file: a linked sheet kept with `mode: 'file'`,
 * or a sheet no imported page links. Committed as a `SiteFile`
 * (`type: 'style'`) plus a `site.runtime.styles` entry, exactly like imported
 * scripts. A linked sheet is scoped to the pages that linked it; an unlinked
 * one has no `pageSources` and applies to every page. `content` is the flattened CSS: the sheet's
 * unconditional local `@import` graph inlined in cascade order, trusted
 * Google-font `@import`s stripped (they install as self-hosted fonts), and
 * `url(...)` payloads normalised to FileMap keys for asset rewriting.
 */
export interface ImportStylesheet {
  /** FileMap path of the source file (e.g. `css/style.css`). */
  path: string
  /** Flattened CSS text. */
  content: string
  /** HTML FileMap sources that linked this stylesheet. Empty: no page linked it, so it is site-wide. */
  pageSources: string[]
  /** Final committed page IDs. Filled by `commitImportPlan` before adapter call. */
  pageIds?: string[]
  /**
   * SHA-256 of the text as the bundle had it, before asset URLs were
   * rewritten. Filled by `commitImportPlan`; the store keeps it in the site
   * file's `importRecord`.
   */
  sourceHash?: string
  /** Cascade ordering within the user-stylesheet bundle; lower applies earlier. */
  priority: number
}

/**
 * A script tag discovered while planning one HTML page, preserving source
 * order across inline executable JavaScript and external `<script src>` tags.
 */
export type PageScript = {
  /** Loader semantics from the source HTML. */
  format: SiteScriptFormat
  /** Where the page ran it: a blocking `<head>` script, or after the body. */
  placement: SiteScriptPlacement
} & (
  /** `path`: the linked FileMap file. */
  | { kind: 'external'; path: string }
  /** `path`: a stable synthetic SiteFile path derived from the HTML file. */
  | { kind: 'inline'; path: string; content: string }
)

// ---------------------------------------------------------------------------
// Phase 2 — Site-import pipeline types
// ---------------------------------------------------------------------------

/** A media/font file the plan will upload, with its raw bytes. */
export interface ImportAsset {
  /** FileMap key — also the token `applyAssetRewrites` swaps for the media URL. */
  sourcePath: string
  mimeType: string
  bytes: Uint8Array
  /**
   * Authored alt text from the first `<img>` that references this file, so
   * the Media Library record is created with it. Absent when no page gave
   * the image an alt attribute.
   */
  altText?: string
}

/** What `SiteImportAdapter.uploadAsset` reports back for one uploaded file. */
export interface UploadedImportAsset {
  /** Public media URL the page tree should reference. */
  url: string
  /**
   * Non-fatal notes about this upload — the asset is in the library and its
   * URL is final, but something around it (folder placement) did not happen.
   */
  warnings: ImportWarning[]
}

/**
 * A normalized map of all files in the import input.
 *
 * Keys are relative paths with `/` separators (no leading `./` or `/`).
 * Produced by `ingestInput.ts` from any of the four input shapes.
 */
export interface FileMap {
  /** All files keyed by normalized relative path. */
  files: Record<string, { bytes: Uint8Array; mimeType?: string }>
  /**
   * When unpacking a ZIP whose every entry shared a single top-level folder,
   * that folder name is recorded here so consumers can surface it in the UI.
   * Undefined when no strip happened.
   */
  strippedTopLevelFolder?: string
}

/**
 * The semantic role of a file in the import.
 * Used by `classifyFiles` to decide how each file is processed.
 */
export type FileRole = 'html' | 'css' | 'js' | 'image' | 'font' | 'binary' | 'meta'

/** A single file with its resolved role and raw bytes. */
export interface ClassifiedFile {
  /** Normalized relative path (FileMap key). */
  path: string
  role: FileRole
  size: number
  bytes: Uint8Array
  mimeType?: string
}

/**
 * A single HTML file processed into a page-ready plan.
 *
 * `nodeFragment` contains the parsed body content. Class names inside the
 * fragment are still raw name strings; the admin-side adapter resolves them
 * into registry ids when calling `addPage`.
 */
export interface PagePlan {
  /** FileMap key of the source HTML file. */
  source: string
  /** Display title derived from `<title>` or prettified filename. */
  title: string
  /** URL-safe slug derived from the filename. */
  slug: string
  /**
   * FileMap keys of CSS files linked by `<link rel="stylesheet">` in the
   * page's `<head>`, expanded to include unconditional local CSS `@import`
   * dependencies. Only paths that exist in the FileMap are included; missing
   * hrefs/imports produce `missing-stylesheet` warnings instead.
   */
  linkedCssPaths: string[]
  /**
   * Executable JavaScript tags in source order. External entries only include
   * paths that exist in the FileMap; missing hrefs produce `missing-script`
   * warnings instead. Non-executable script data (`application/json`,
   * import maps, templates, etc.) is intentionally skipped.
   */
  scripts: PageScript[]
  /**
   * The body content as a flat node fragment.
   *
   * URL-shaped props (`src`, `href`, `srcset`, `videoUrl`, `poster`) are normalized to FileMap keys
   * (relative paths) so that `applyAssetRewrites` can do exact-string
   * replacement without needing the original base path.
   */
  nodeFragment: ImportFragment
  /**
   * Authored `alt` per `base.image` node id, for every `<img>` that carried
   * an alt attribute (an empty string is a deliberate decorative alt). Alt is
   * not a per-instance prop — the Media Library asset is the source of truth
   * — so `buildAssetPlan` carries it onto the planned asset and the upload
   * creates the record with it.
   */
  imageAlts: Record<string, string>
  /**
   * The page's `<head>` read into its SEO settings (`headSeo.ts`), or null
   * when the head held nothing beyond title, stylesheets and scripts. URL
   * fields (favicon, link hrefs, Open Graph / Twitter images) are normalised
   * to FileMap keys by `buildAssetPlan`, like node props.
   */
  seo: PageSeo | null
}

/**
 * The fully-analysed import plan.
 *
 * Produced by `buildImportPlan`. Consumed by `commitImportPlan` (which calls
 * the adapter) and by the Phase 3 wizard UI (for preview and conflict
 * resolution).
 *
 * All URL-shaped values inside `pages[].nodeFragment` and
 * `styleRules[].styles` / `contextStyles` are normalized to FileMap keys
 * so that `applyAssetRewrites` can replace them with new media URLs.
 */
export interface ImportPlan {
  pages: PagePlan[]
  styleRules: NewStyleRule[]
  /**
   * Index-aligned with `styleRules`: the FileMap key of the source stylesheet
   * each rule was parsed from (a real `.css` path, or a synthetic
   * `<htmlPath>::inline` key for an inline `<style>` block). Wizard-side
   * grouping only: every rule, including ones the cross-sheet resolver
   * materialises, has a display group here. The durable identity a re-import
   * reconciles against is `rule.origin` (source + ordinal), stamped by
   * `buildAssetPlan` and persisted on the committed `StyleRule`.
   */
  styleRuleSources: string[]
  /**
   * Custom font families synthesized from imported `@font-face` blocks. Each
   * file's `src` is a FileMap key here; `applyAssetRewrites` rewrites it to the
   * uploaded media URL, then `commitImportPlan` assembles a `FontEntry`.
   */
  fonts: ImportFontFamily[]
  /**
   * Google font families extracted from trusted CSS2 `@import` rules. Commit
   * installs these into `site.settings.fonts.items` through the normal CMS
   * Google-font installer before font tokens are added.
   */
  googleFonts: ImportGoogleFont[]
  /**
   * Reusable site-level conditions referenced by `styleRules[].contextStyles`
   * keys (custom @media / @container / @supports). Merged into `site.conditions`
   * on commit.
   */
  conditions: ConditionDef[]
  /** Assets to upload, with their raw bytes. */
  assets: ImportAsset[]
  /**
   * Colour-valued custom properties pulled from root-scope rules, ready to
   * commit into the CMS colours system. Deduped by slug across all CSS files.
   */
  colors: ImportColorToken[]
  /**
   * Root `--font-*` variables pulled from imported CSS, ready to commit into
   * `site.settings.fonts.tokens`.
   */
  fontTokens: ImportFontToken[]
  /**
   * JavaScript files linked by imported pages, committed as page-scoped site
   * scripts. Unlinked JS files stay as imported media assets instead of being
   * executed.
   */
  scripts: ImportScript[]
  /**
   * Every top-level stylesheet linked by ≥1 imported page, with the import
   * mode this plan was built with. Drives the wizard's per-sheet mode picker.
   */
  linkedStylesheets: LinkedStylesheet[]
  /**
   * Stylesheets that import as SiteFiles: linked sheets kept as files
   * (`mode: 'file'`, page-scoped) and sheets no page links (site-wide).
   */
  stylesheets: ImportStylesheet[]
  conflicts: {
    pages: PageConflict[]
    rules: RuleConflict[]
    tokens: TokenConflict[]
    /** Divergent cross-sheet class definitions among CONVERTED stylesheets. */
    crossSheetClasses: CrossSheetClassConflict[]
    /** Scripts and kept stylesheets whose site file path already exists. */
    files: FileConflict[]
    /**
     * Media files already in the library. Always empty from `buildImportPlan`
     * (it is pure and cannot ask the server); filled by `detectMediaConflicts`.
     */
    media: MediaConflict[]
  }
  warnings: ImportWarning[]
  /**
   * Source text snippets of @-rules that could not be modelled
   * (from `dropped-at-rule` warnings in the CSS parser).
   */
  droppedAtRules: string[]
}

/**
 * The committed result of applying an ImportPlan through a SiteImportAdapter.
 *
 * Returned by `commitImportPlan`. Provides enough information for the
 * Phase 3 wizard's "Done" step to show a summary.
 */
export interface ImportResult {
  pages: { id: string; title: string; slug: string; source: string }[]
  styleRules: { id: string; selector: string; kind: 'class' | 'ambient' }[]
  /** Fonts imported into the installed font library. */
  fonts: { id: string; family: string }[]
  assets: { sourcePath: string; mediaUrl: string }[]
  /** Colour tokens committed into the framework colours system. */
  colors: { slug: string; value: string }[]
  /** Font tokens committed into `site.settings.fonts.tokens`. */
  fontTokens: { id: string; name: string; variable: string }[]
  /** Site scripts committed from imported JS files. */
  scripts: { id: string; path: string }[]
  /** Stylesheets committed as SiteFiles: kept linked sheets and unlinked site-wide ones. */
  stylesheets: { id: string; path: string }[]
  /** Resolved conflicts (mirrors ImportPlan.conflicts with final actions). */
  conflicts: ImportPlan['conflicts']
  warnings: ImportWarning[]
}
