// ---------------------------------------------------------------------------
// Frontend asset injection — declarative per-plugin tag list
// ---------------------------------------------------------------------------
//
// Every tag a plugin wants injected into a published page is declared up front
// in the manifest's `frontend.assets[]` array. The host reads this array at
// publish time, expands `hostRuntime` references against its small built-in
// registry, dedupes shared runtimes across plugins, and splices the resulting
// tags into the document at four well-known anchors. No worker round-trip, no
// imperative `register(...)` call at activate time — the manifest is the
// single source of truth, statically inspectable from the install consent
// screen.
//
// `frontend.assets` requires the `frontend.assets` permission. CSP is relaxed
// automatically based on what the plan actually contains: an external script
// adds `script-src 'self'`, an executed inline script adds its own hash.
// `'unsafe-inline'` is never granted to scripts, so inline code runs only when
// it is declared here as a `script-inline` asset; inline event handlers
// (`onclick="…"`) and inline scripts added to the page any other way are
// blocked by the browser.
//
// Naming the placement anchors:
//   - 'head'        → at the top of <head>, directly below the charset and
//                     the page's Content-Security-Policy (rare; for things
//                     that must come before the page's own head content).
//                     Nothing a plugin declares is placed above the policy.
//   - 'head-end'    → just before </head>. Default for <meta>, <link>,
//                     stylesheets, JSON-LD, preconnects.
//   - 'body-start'  → just after <body …>, before page content. Default for
//                     shared host runtimes that need to install
//                     `window.__instatic.*` BEFORE plugin scripts that depend on it.
//   - 'body-end'    → just before </body>. Default for deferred plugin
//                     bundles (analytics trackers, widget bootstraps).
// ---------------------------------------------------------------------------

export type FrontendAssetPlacement = 'head' | 'head-end' | 'body-start' | 'body-end'

/**
 * One declarative tag the host injects into the published page. See
 * `PluginManifest.frontend` for context. Discriminated by `kind`; each
 * variant carries only the fields it needs so authors can't, for example,
 * declare both `src` and `inline` on the same script.
 */
export type FrontendAsset =
  /**
   * External JS file. `src` is either a file shipped in the plugin zip
   * (resolved against `assetBasePath`) or an absolute `https://` address on a
   * host declared in `frontend.origins.scripts`. Emits one `<script>` tag at
   * the given placement. `strategy` maps to the matching HTML attribute (or
   * `module` for ESM).
   */
  | {
    kind: 'script'
    src: string
    placement?: FrontendAssetPlacement
    strategy?: 'defer' | 'async' | 'module' | 'sync'
    /** Extra attributes (e.g. `type`, `crossorigin`, `integrity`, `data-*`). */
    attrs?: Record<string, string>
  }
  /**
   * Inline `<script>` block. The host wraps `content` in a `<script>` tag at
   * the given placement and allows exactly this script in the page CSP by its
   * hash (line endings are normalised to LF first). A data block, such as
   * `attrs: { type: 'application/ld+json' }`, is not executed and changes
   * nothing in the policy.
   */
  | {
    kind: 'script-inline'
    content: string
    placement?: FrontendAssetPlacement
    attrs?: Record<string, string>
  }
  /**
   * External CSS file shipped in the plugin zip. Emits one
   * `<link rel="stylesheet" href="…">` tag.
   */
  | {
    kind: 'style'
    href: string
    placement?: FrontendAssetPlacement
    attrs?: Record<string, string>
  }
  /**
   * Inline `<style>` block. Triggers `style-src 'unsafe-inline'` in the
   * page CSP.
   */
  | {
    kind: 'style-inline'
    content: string
    placement?: FrontendAssetPlacement
    attrs?: Record<string, string>
  }
  /**
   * Bare `<link>` tag — for preconnect, dns-prefetch, preload, alternate,
   * etc. The `attrs` object becomes the tag attributes; no body, no inline
   * content. Use `kind: 'style'` for stylesheet links — the host derives
   * the right tag shape for you.
   */
  | {
    kind: 'link'
    attrs: Record<string, string>
    placement?: FrontendAssetPlacement
  }
  /**
   * Bare `<meta>` tag. The `attrs` object becomes the tag attributes.
   */
  | {
    kind: 'meta'
    attrs: Record<string, string>
    placement?: FrontendAssetPlacement
  }

/**
 * Third-party origins a plugin's published-page code may use. Each entry is a
 * bare hostname (`js.example.com`) or a leading-`*.` wildcard
 * (`*.example.com`); the host always emits it as `https://<host>`.
 */
export interface PluginFrontendOrigins {
  /** Hosts scripts may be loaded from. Added to the page's `script-src`. */
  scripts?: string[]
  /** Hosts frames may be embedded from. Added to the page's `frame-src`. */
  frames?: string[]
}

/**
 * Manifest-level `frontend` block: the `assets` array and the third-party
 * `origins` published pages may load from.
 */
export interface PluginFrontendDeclarations {
  /**
   * Every tag the host should inject into the published page on behalf of
   * this plugin. Order within the array is preserved per placement; tags
   * with the same placement are emitted in declaration order.
   */
  assets: FrontendAsset[]
  /**
   * Third-party script and frame origins, granted with `frontend.assets` and
   * listed on the install / upgrade review.
   */
  origins?: PluginFrontendOrigins
}
