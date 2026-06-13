/**
 * Shared types for the Super Import pipeline (Phase 1+).
 *
 * These types are headless — no admin/React/server imports allowed here.
 * @see src/__tests__/architecture/siteImport-headless.test.ts
 */

import type { StyleRule, ConditionDef } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'
import type { FontFileFormat } from '@core/fonts'
import type { SiteScriptFormat } from '@core/site-runtime'

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
// ImportWarning
// ---------------------------------------------------------------------------

/**
 * Categories of warnings that the import pipeline can emit.
 *
 * Phase 1 (CSS parser) kinds:
 * - `dropped-at-rule`: an @-rule that the engine can't model was silently
 *   dropped (@page, @namespace, @layer, etc.). `@keyframes`, `@font-face`,
 *   `@supports`, and `@container` are imported through dedicated paths.
 * - `unmatched-media-query`: an @media query that could not be matched to any
 *   defined viewport context. Inner declarations are still imported under a
 *   reusable media condition so nothing is silently lost.
 * - `invalid-rule`: a rule that the CSS engine rejected (typically a sheet-
 *   level parse error that causes `replaceSync` to throw).
 * - `unknown-property`: legacy — retained for back-compat with any persisted
 *   warnings. The Phase 1a permissive property model no longer emits this; a
 *   declaration is only dropped when its NAME is denied (see
 *   `blocked-property`), not when it's merely uncurated.
 * - `blocked-property`: a CSS declaration whose property name is on the
 *   security denylist (`behavior`, `-moz-binding`, …). Rare. The declaration
 *   is dropped from the rule.
 * - `asset-reference`: informational — a `url(...)` payload was found in a
 *   declaration value. Assets are collected in `assetRefs` (not warnings) by
 *   the Phase 1 parser; this kind is reserved for Phase 2's use.
 * - `duplicate-class`: two `.foo { ... }` rules with the same class selector
 *   appeared in the same file. The later rule's declarations win (CSS cascade
 *   semantics). One warning is emitted per duplicated class.
 *
 * Phase 2 (site import pipeline) kinds:
 * - `missing-stylesheet`: a stylesheet referenced from an HTML `<link>` or a
 *   local CSS `@import` was not found in the FileMap. The page is still
 *   imported; the missing CSS is noted but not fatal.
 * - `missing-script`: a `<script src>` referenced in an HTML file was not
 *   found in the FileMap. The page is still imported; the missing script is
 *   noted but not fatal.
 * - `asset-upload-failed`: an individual asset upload was rejected by the
 *   media library (e.g. unsupported MIME, oversized file, server error).
 *   The remaining assets continue to upload; the failed file is left
 *   referenced in the source HTML/CSS by its original FileMap path so the
 *   import doesn't degrade pages or rules. Surface the warning in the
 *   wizard's Done step so the user can re-upload manually.
 * - `font-install-failed`: a Google Fonts CSS2 import was understood, but the
 *   CMS Google-font installer could not download/register the self-hosted
 *   files. The import continues; affected font tokens fall back to their
 *   authored fallback stacks.
 * - `external-font`: an `@font-face` whose every `src` is an external URL
 *   (or `local(...)` only) — nothing to upload, so the face is skipped rather
 *   than imported. The user can re-add the font by hand. Self-hosted faces
 *   (a bundled `.woff2`/`.woff`/`.ttf`/`.otf`) ARE imported as custom fonts.
 */
type ImportWarningKind =
  | 'dropped-at-rule'
  | 'unmatched-media-query'
  | 'invalid-rule'
  | 'unknown-property'
  | 'blocked-property'
  | 'asset-reference'
  | 'duplicate-class'
  | 'missing-stylesheet'
  | 'missing-script'
  | 'asset-upload-failed'
  | 'font-install-failed'
  | 'external-font'

export interface ImportWarning {
  kind: ImportWarningKind
  /** Human-readable description of what was dropped or why. */
  message: string
  /**
   * For CSS warnings: the raw CSS source text that triggered the warning,
   * truncated to ~120 chars with a trailing `…` if cut.
   * For `missing-stylesheet`: the HTML/CSS file that referenced the missing CSS.
   */
  source?: string
  /** The CSS selector relevant to the warning (for unknown-property, duplicate-class). */
  selector?: string
  /** The camelCase property name (for unknown-property warnings). */
  property?: string
  /**
   * File path relevant to the warning (for `missing-stylesheet`: the unresolved
   * CSS href as it appeared in the HTML source).
   */
  path?: string
}

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
export interface ImportGoogleFont {
  family: string
  variants: string[]
  subsets: string[]
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
 * into `site.settings.fonts.tokens` so `font-family: var(--font-primary)` keeps
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
  /** HTML FileMap sources that linked this script. */
  pageSources: string[]
  /** Final committed page IDs. Filled by `commitImportPlan` before adapter call. */
  pageIds?: string[]
  /** Runtime ordering; lower runs earlier. Derived from first HTML occurrence. */
  priority: number
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
 * A stylesheet kept as a file (`mode: 'file'`). Committed as a `SiteFile`
 * (`type: 'style'`) plus a page-scoped `site.runtime.styles` entry, exactly
 * like imported scripts. `content` is the flattened CSS: the sheet's
 * unconditional local `@import` graph inlined in cascade order, trusted
 * Google-font `@import`s stripped (they install as self-hosted fonts), and
 * `url(...)` payloads normalised to FileMap keys for asset rewriting.
 */
export interface ImportStylesheet {
  /** FileMap path of the source file (e.g. `css/style.css`). */
  path: string
  /** Flattened CSS text. */
  content: string
  /** HTML FileMap sources that linked this stylesheet. */
  pageSources: string[]
  /** Final committed page IDs. Filled by `commitImportPlan` before adapter call. */
  pageIds?: string[]
  /** Cascade ordering within the user-stylesheet bundle; lower applies earlier. */
  priority: number
}

/**
 * A script tag discovered while planning one HTML page, preserving source
 * order across inline executable JavaScript and external `<script src>` tags.
 */
export type PageScript =
  | {
    kind: 'external'
    /** FileMap path of the linked JavaScript file. */
    path: string
    /** Loader semantics from the source HTML. */
    format: SiteScriptFormat
  }
  | {
    kind: 'inline'
    /** Stable synthetic SiteFile path derived from the source HTML file. */
    path: string
    /** Inline JavaScript source. */
    content: string
    /** Loader semantics from the source HTML. */
    format: SiteScriptFormat
  }

// ---------------------------------------------------------------------------
// Phase 2 — Site-import pipeline types
// ---------------------------------------------------------------------------

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
   * URL-shaped props (`src`, `href`, `srcset`) are normalized to FileMap keys
   * (relative paths) so that `applyAssetRewrites` can do exact-string
   * replacement without needing the original base path.
   */
  nodeFragment: ImportFragment
}

/** How a slug, rule-name, or token-variable conflict is resolved for a single item. */
export interface ConflictResolution {
  action: 'auto-rename' | 'overwrite' | 'skip' | 'custom-rename'
  /** Resolved slug (for page conflicts; defined when action !== 'skip'). */
  resolvedSlug?: string
  /** Resolved name (for rule conflicts; defined when action !== 'skip'). */
  resolvedName?: string
  /**
   * Resolved CSS custom-property name without leading `--` (for token conflicts;
   * defined when action is `auto-rename` or `custom-rename`).
   */
  resolvedVariable?: string
}

/** A page slug that collides with an existing page. */
export interface PageConflict {
  /** FileMap key of the HTML source file. */
  source: string
  /** The slug the importer wanted to use. */
  desiredSlug: string
  /** ID of the existing page that owns the slug. */
  existingPageId: string
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * A `kind:'class'` rule name that collides with an existing class rule.
 *
 * Ambient rules NEVER conflict — multiple ambient rules with the same
 * selector are allowed; cascade resolves by `order`.
 */
export interface RuleConflict {
  /** FileMap key of the CSS source file (or empty if unknown). */
  source: string
  /** The class name the importer wanted to use. */
  desiredName: string
  /** ID of the existing StyleRule that owns the name. */
  existingRuleId: string
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * One divergent cross-sheet definition of a class name among CONVERTED
 * stylesheets: two page cascades define the same class with different
 * effective declarations. The first-encountered definition keeps the bare
 * name; each later distinct definition raises one conflict.
 *
 * Resolutions (applied by `applyCrossSheetClassResolutions`):
 * - `auto-rename` / `custom-rename` (default): this definition moves to
 *   `resolvedName` — its pages' class tokens and its cascade's selectors
 *   follow, so every page keeps rendering with its own styles.
 * - `skip`: drop this definition; its pages bind to the first definition.
 * - `overwrite`: this definition wins the bare name; the other definitions'
 *   class fragments are dropped and their pages bind to this one.
 */
export interface CrossSheetClassConflict {
  /** The colliding class name as authored in the source CSS. */
  desiredName: string
  /** Stable id of this divergent definition (hash of its effective declarations). */
  definitionId: string
  /**
   * CSS file paths whose class fragments produce this definition and are not
   * shared with the kept (first) definition's cascades.
   */
  sources: string[]
  /** HTML page sources rendered with this definition. */
  pageSources: string[]
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * A design-token CSS custom property (`--bg`, `--font-primary`) extracted from
 * the import that collides with an existing token in the site.
 *
 * Both colour tokens (keyed by `--<slug>`) and font tokens (keyed by
 * `--font-*`) are modelled here: they are the same thing — a `--var` contract
 * referenced by `var(--x)` in the imported CSS — and resolve through one UI.
 *
 * `auto-rename` / `custom-rename` rename the imported token AND rewrite every
 * `var(--old)` reference in the imported style rules and node inline styles to
 * the new name, so the imported design stays faithful. `skip` keeps the
 * existing token (imported `var(--x)` binds to it). `overwrite` replaces the
 * existing token's value, keeping its name so both sides keep resolving.
 */
export interface TokenConflict {
  /** Which registry the token lives in. */
  kind: 'color' | 'font'
  /**
   * The CSS custom-property name without the leading `--` the importer wanted
   * (e.g. `bg` for `--bg`, `font-primary` for `--font-primary`).
   */
  desiredVariable: string
  /** ID of the existing token (framework colour / font token) that owns the name. */
  existingTokenId: string
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
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
   * `<htmlPath>::inline` key for an inline `<style>` block). Import-time
   * metadata only — used by the wizard to group rules by source stylesheet.
   * NOT persisted onto the committed `StyleRule`.
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
  assets: { sourcePath: string; mimeType: string; bytes: Uint8Array }[]
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
  /** Stylesheets kept as files (`mode: 'file'`), ready to commit as SiteFiles. */
  stylesheets: ImportStylesheet[]
  conflicts: {
    pages: PageConflict[]
    rules: RuleConflict[]
    tokens: TokenConflict[]
    /** Divergent cross-sheet class definitions among CONVERTED stylesheets. */
    crossSheetClasses: CrossSheetClassConflict[]
  }
  warnings: ImportWarning[]
  /**
   * Source text snippets of @-rules that could not be modelled
   * (from `dropped-at-rule` warnings in the CSS parser).
   */
  droppedAtRules: string[]
  /** CSS files present in the FileMap but not linked by any imported page. */
  unusedCss: string[]
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
  /** Stylesheets committed as page-scoped SiteFiles (`mode: 'file'`). */
  stylesheets: { id: string; path: string }[]
  /** Resolved conflicts (mirrors ImportPlan.conflicts with final actions). */
  conflicts: ImportPlan['conflicts']
  warnings: ImportWarning[]
}

// ---------------------------------------------------------------------------
// Typed error classes for the import pipeline
// ---------------------------------------------------------------------------

/** Thrown when the import input contains no processable files. */
export class EmptyImportError extends Error {
  constructor() {
    super('Import input is empty — drop at least one file')
    this.name = 'EmptyImportError'
  }
}

/** Thrown when the aggregate input size exceeds the configured limit. */
export class OversizeImportError extends Error {
  readonly sizeBytes: number
  readonly limitBytes: number
  constructor(sizeBytes: number, limitBytes: number) {
    super(
      `Import aggregate size ${sizeBytes} bytes exceeds the ${limitBytes}-byte limit`,
    )
    this.name = 'OversizeImportError'
    this.sizeBytes = sizeBytes
    this.limitBytes = limitBytes
  }
}

/** Thrown when a zip's uncompressed size exceeds the zip-bomb guard limit. */
export class ZipBombError extends Error {
  readonly uncompressedBytes: number
  readonly limitBytes: number
  constructor(uncompressedBytes: number, limitBytes: number) {
    super(
      `Zip uncompressed size ${uncompressedBytes} bytes exceeds the ${limitBytes}-byte limit (zip-bomb guard)`,
    )
    this.name = 'ZipBombError'
    this.uncompressedBytes = uncompressedBytes
    this.limitBytes = limitBytes
  }
}

/** Thrown when the file count in the import exceeds the configured limit. */
export class TooManyFilesError extends Error {
  readonly count: number
  readonly limit: number
  constructor(count: number, limit: number) {
    super(`Import contains ${count} files, exceeding the ${limit}-file limit`)
    this.name = 'TooManyFilesError'
    this.count = count
    this.limit = limit
  }
}

/**
 * Thrown when a path contains `..` segments, an absolute prefix (`/` or a
 * Windows drive letter), or other traversal attempts.
 */
export class PathTraversalError extends Error {
  readonly path: string
  constructor(path: string) {
    super(`Unsafe path rejected — path traversal or absolute path detected: "${path}"`)
    this.name = 'PathTraversalError'
    this.path = path
  }
}
