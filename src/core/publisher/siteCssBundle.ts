/**
 * Site CSS bundle — type definitions for the four external CSS files served
 * at `/_instatic/css/<filename>` for every published page.
 *
 * The IMPLEMENTATION (`buildSiteCssBundle`) lives in `server/publish/siteCssBundle.ts`
 * because it depends on `node:crypto` for content hashing. Only the type shape
 * lives in `src/core/publisher/` so that `publishPage()` can accept a bundle
 * without dragging server-only code into the editor build.
 *
 * File split
 * ──────────
 *   reset.<hash>.css       — The publisher reset (`PUBLISHER_RESET_CSS`).
 *                            Constant across every project; aggressive
 *                            shared-cache hit across the whole CMS install.
 *
 *   framework.<hash>.css   — Platform-emitted CSS:
 *                               · @font-face declarations (`@font-face` + `--font-*` tokens)
 *                               · framework color / typography / spacing variables
 *                               · generated framework utilities, tree-shaken by
 *                                 site preference unless explicitly disabled
 *                               · plugin-emitted module CSS (deduped by moduleId,
 *                                 collected across every page on the site).
 *                             Hash rotates when site framework settings or the
 *                             set of plugin modules in use change.
 *
 *   style.<hash>.css       — User-authored class registry (`collectClassCSS`).
 *                             Hash rotates on every class edit.
 *
 *   userStyles.<hash>.css  — User-authored global stylesheets from
 *                             `site.files[type === 'style']`. Concatenated in
 *                             stable path-sort order so users can predict the
 *                             cascade between their own files. Loaded last so
 *                             user-written rules win specificity ties against
 *                             the class registry.
 *                             Hash rotates on any user-stylesheet edit;
 *                             isolated from `style.css` so a class-only edit
 *                             doesn't bust the user-CSS cache and vice versa.
 *
 * Cache strategy
 * ──────────────
 * Filenames embed a content-hash (SHA-256, truncated to 12 hex chars). The
 * server can therefore answer with `Cache-Control: public, max-age=31536000,
 * immutable` — any change to the bundle produces a fresh URL, so stale content
 * is impossible.
 *
 * Cascade order
 * ─────────────
 * The published page emits `<link rel="stylesheet">` tags in this order:
 *   reset → framework → style → userStyles
 * Source-order resolves specificity ties: user-authored global CSS wins over
 * the class registry, the class registry wins over framework, and the reset
 * wins nothing.
 */

/**
 * Logical bundle name. Lives here so any consumer that switches on bundle id
 * (route handler, link emitter) stays in lockstep with the type.
 */
export type SiteCssBundleId = 'reset' | 'framework' | 'style' | 'userStyles'

/**
 * One built CSS file. `filename` already includes the content hash and `.css`
 * extension, ready to drop into the `/_instatic/css/` URL or a `<link>` href.
 */
export interface CssBundleFile {
  /** Logical bundle this file belongs to. */
  bundle: SiteCssBundleId
  /** `<bundle>-<hash>.css`. */
  filename: string
  /** Content hash (SHA-256, 12 hex chars). */
  hash: string
  /** CSS body (no `<style>` wrapper). */
  content: string
}

export interface SiteCssBundle {
  reset: CssBundleFile
  framework: CssBundleFile
  style: CssBundleFile
  userStyles: CssBundleFile
}
