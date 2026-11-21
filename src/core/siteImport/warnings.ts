/**
 * ImportWarning — the one warning shape every site import phase reports.
 */

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
 *   appeared in the same file. Each occurrence stays its own rule at its own
 *   source position (CSS cascade semantics). One warning per repeat.
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
 * - `unresolved-asset`: an HTML/CSS reference to a media file (image, font,
 *   video, …) that the archive does not contain under that path — not even
 *   after the punctuation-insensitive fallback match. The reference is left
 *   pointing at its original path, so the page imports with a broken image
 *   rather than losing the element. One warning per distinct missing path.
 * - `missing-svg-sprite`: an SVG icon reference could not be expanded.
 * - `asset-folder-failed`: the asset uploaded and its URL was rewritten, but
 *   placing it under the folder that mirrors its bundle path failed (folder
 *   listing or creation rejected). The asset sits at the media root; the user
 *   can drag it into place. Never blocks the URL rewrite (#409).
 * - `script-order-conflict`: two pages link the same scripts in contradictory
 *   orders, so no single load order satisfies both. The order from the page
 *   that links them first wins; `path` names the first script of the cycle.
 * - `head-tag-dropped`: a `<head>` tag the page's SEO settings cannot hold
 *   (`http-equiv`, a script preload, an unknown `rel`, JSON-LD that is not
 *   JSON). Everything else in the head imports into `PagePlan.seo`.
 * - `head-file-not-hosted`: a head link points at a file in the archive that
 *   the media library cannot store (`llms.txt`, a web manifest). The link is
 *   kept, pointing at the file's root-relative path, so it works once the
 *   file is served at that path; `path` names it.
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
  | 'asset-folder-failed'
  | 'font-install-failed'
  | 'external-font'
  | 'missing-svg-sprite'
  | 'unresolved-asset'
  | 'dependency-version-kept'
  | 'script-order-conflict'
  | 'head-tag-dropped'
  | 'head-file-not-hosted'

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

