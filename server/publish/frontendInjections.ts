/**
 * Frontend asset injection — build a per-render plan from every enabled
 * plugin's manifest and splice the resulting tags into the published HTML.
 *
 * Single permission gating the whole surface: `frontend.assets`. Every tag
 * is declared up front in the plugin's manifest under `frontend.assets[]`
 * (see `FrontendAsset` in `@core/plugin-sdk/types`). The host does NOT ship
 * any tag content of its own — no built-in tracker, no shared runtime, no
 * special-cased scripts. If a plugin wants `window.__instatic_analytics`, that
 * plugin ships the IIFE that installs it. The host's job is to:
 *
 *   1. Walk enabled plugins, gather their declared assets.
 *   2. Resolve `src` / `href` against `assetBasePath` so URLs point at the
 *      plugin's own upload directory.
 *   3. Bucket by placement anchor: `head` / `head-end` / `body-start` / `body-end`.
 *   4. Emit one tag per asset (no dedup beyond identical-attribute tags),
 *      preserving per-plugin declaration order.
 *   5. Relax the page CSP based on what the plan actually contains. Every
 *      relaxation ADDS to the policy the publisher emitted; none replaces it:
 *        - any script tag → `script-src` gains `'self'`
 *        - inline script that a browser executes → `script-src` also gains
 *          that script's own `'sha256-…'`. `'unsafe-inline'` is never added:
 *          a policy that carries a hash (the importmap's, or these) makes
 *          browsers ignore it, so the only inline code that runs on a
 *          published page is a declared `script-inline` asset. Inline event
 *          handlers and inline scripts added any other way are blocked.
 *          Data blocks (`type="application/ld+json"` and the like) are not
 *          executed, need no grant, and leave the policy alone.
 *        - inline style  → `style-src`  gains `'unsafe-inline'`
 *        - `networkAllowedHosts` of every contributing plugin that can run
 *          code in the visitor's browser (a declared asset or origin, or a
 *          canvas module pack) → appended to `connect-src`, whether or not it
 *          ships a tag. A plugin with server-side hosts only adds nothing.
 *        - plugin-declared `frontend.origins` → `scripts` appended to
 *          `script-src`, `frames` to `frame-src`
 *      A plan with nothing but meta / link / data-block tags and no hosts
 *      gets no CSP changes.
 *
 * Pure data assembly — no DOM, no fetch. Called from a single place at the
 * dispatcher (`server/router.ts → tryServePublishedPage / tryServeContentRoute`),
 * so every HTML-emitting render path gets the same treatment.
 */

import { createHash } from 'node:crypto'
import type { DbClient } from '../db/client'
import { listInstalledPlugins, type InstalledPluginResult } from '../repositories/plugins'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { listElectedAdapters } from '../repositories/mediaStorageAdapters'
import { addCspSources, insertAfterCspMeta, rewriteCspMeta } from '@core/publisher'
import {
  externalFrontendScriptHost,
  frontendOriginAllowsHost,
  isExternalFrontendScriptSrc,
} from '@core/plugins/manifest'
import type {
  FrontendAsset,
  FrontendAssetPlacement,
  InstalledPlugin,
} from '@core/plugin-sdk'

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

/** Placement anchors in the order they appear in a published document. */
export const FRONTEND_PLACEMENT_ORDER: ReadonlyArray<FrontendAssetPlacement> = [
  'head',
  'head-end',
  'body-start',
  'body-end',
]

/**
 * A fully-resolved tag, ready to be spliced into the document. Carries its
 * placement anchor so the splicer can bucket without re-walking the asset.
 */
interface ResolvedTag {
  html: string
  placement: FrontendAssetPlacement
}

const NO_HOST_OWNED_ATTRS = new Set<string>()
const SCRIPT_HOST_OWNED_ATTRS = new Set(['src', 'defer', 'async'])
const MODULE_SCRIPT_HOST_OWNED_ATTRS = new Set(['src', 'defer', 'async', 'type'])
const INLINE_SCRIPT_HOST_OWNED_ATTRS = new Set(['src'])
const STYLESHEET_HOST_OWNED_ATTRS = new Set(['href', 'rel'])

export interface FrontendInjections {
  /**
   * Tags to splice at each placement anchor. Order within each bucket
   * matches declaration order across plugins (plugins iterated alphabetically
   * by id; within a plugin, in manifest order).
   */
  tags: Record<FrontendAssetPlacement, string[]>
  /**
   * Whether the plan holds an inline `<script>` a browser executes (not a
   * data block). When true, the page CSP gets `script-src 'self'` plus each
   * script's hash from `inlineScriptHashes`.
   */
  hasInlineScript: boolean
  /**
   * Whether any inline `<style>` tag (or `style-inline` asset) is present.
   * When true, the page CSP gets `style-src 'unsafe-inline'`.
   */
  hasInlineStyle: boolean
  /**
   * Whether any external (src) `<script>` tag is present. When true, the
   * page CSP keeps the relaxed `worker-src 'self' blob:` (matches the old
   * behaviour for plugin bundles that spin up workers).
   */
  hasExternalScript: boolean
  /**
   * Union of `networkAllowedHosts` declared by every contributing plugin
   * (see `listFrontendAssetPlugins`). Appended to the page CSP's
   * `connect-src` so visitor-side `fetch()` from plugin frontend code
   * reaches the hosts the manifest declared. A plugin contributes its own
   * hosts once it can run code in the visitor's browser
   * (`runsCodeInVisitorBrowser`), whether or not it ships a tag; another
   * plugin's tag is never what lets them through.
   */
  networkAllowedHosts: string[]
  /**
   * `'sha256-…'` source expressions, one per executed inline `<script>` in
   * the plan, taken over exactly the text a browser hashes (line endings
   * normalised to LF, as the HTML parser does). These are the only grant an
   * inline script gets: `'unsafe-inline'` is never emitted for scripts.
   */
  inlineScriptHashes: string[]
  /**
   * Union of `frontend.origins.scripts` across contributing plugins. Appended
   * to `script-src` so a declared third-party script can load.
   */
  scriptOrigins: string[]
  /**
   * Union of `frontend.origins.frames` across contributing plugins. Appended
   * to `frame-src` so a declared third-party frame can be embedded.
   */
  frameOrigins: string[]
  /**
   * CSP origins declared by elected media storage adapters. Appended to
   * `img-src` / `media-src` / `connect-src` so the browser can load assets
   * from the adapter's backend.
   */
  mediaCspOrigins: ReadonlyArray<{
    directive: 'img-src' | 'media-src' | 'connect-src'
    origin: string
  }>
}

// ---------------------------------------------------------------------------
// Collection — walk installed plugins, build a plan
// ---------------------------------------------------------------------------

/**
 * The plugins whose code may run on a published page, in emission order. This
 * is the ONE place that decides whose `frontend.assets[]`, `frontend.origins`
 * and `networkAllowedHosts` reach a page: enabled, not in the error state, and
 * GRANTED `frontend.assets` (never the declared `permissions`). That grant is
 * also what lets a plugin module ship JS, so a plugin with no declared tag
 * still belongs here. The publisher (`collectFrontendInjections`) and the
 * editing canvas (`./canvasStylesheets.ts`) both start here, so the two
 * cannot drift.
 */
export async function listFrontendAssetPlugins(db: DbClient): Promise<InstalledPlugin[]> {
  const results = await listInstalledPlugins(db)

  // Broken plugins (corrupt manifest_json) have no parseable frontend assets —
  // skip them entirely. Only ok-parsed, enabled, non-error plugins contribute.
  const okPlugins = results
    .filter((r): r is Extract<InstalledPluginResult, { kind: 'ok' }> => r.kind === 'ok')
    .map((r) => r.plugin)

  // Sort by plugin id so the emitted tag order is deterministic across
  // re-renders. Two plugins declaring the same placement get a stable
  // top-down emission.
  return okPlugins
    .filter((p) => p.enabled && p.lifecycleStatus !== 'error')
    .filter((p) => p.grantedPermissions.includes('frontend.assets'))
    .sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0))
}

/**
 * Whether a plugin from `listFrontendAssetPlugins` can run code in a visitor's
 * browser, which is what entitles its `networkAllowedHosts` to `connect-src`:
 * it declares at least one frontend asset or origin, or it ships a canvas
 * module pack (`entrypoints.modules`), whose modules may render JS. Which
 * modules actually emit JS is only known per render, so the pack is the
 * per-plugin stand-in. A plugin whose hosts are for its server code alone
 * contributes nothing, and its pages stay as the publisher emitted them.
 */
function runsCodeInVisitorBrowser(plugin: InstalledPlugin): boolean {
  const frontend = plugin.manifest.frontend
  const declared =
    (frontend?.assets.length ?? 0) +
    (frontend?.origins?.scripts?.length ?? 0) +
    (frontend?.origins?.frames?.length ?? 0)
  return declared > 0 || Boolean(plugin.manifest.entrypoints?.modules)
}

export async function collectFrontendInjections(db: DbClient): Promise<FrontendInjections> {
  const eligible = await listFrontendAssetPlugins(db)
  const tags: Record<FrontendAssetPlacement, string[]> = {
    'head': [],
    'head-end': [],
    'body-start': [],
    'body-end': [],
  }
  const networkAllowedHostsSet = new Set<string>()
  const inlineScriptHashes = new Set<string>()
  const scriptOrigins = new Set<string>()
  const frameOrigins = new Set<string>()
  let hasInlineScript = false
  let hasInlineStyle = false
  let hasExternalScript = false

  for (const plugin of eligible) {
    const assets = plugin.manifest.frontend?.assets ?? []
    for (const asset of assets) {
      const resolved = renderAsset(asset, plugin)
      if (!resolved) continue
      tags[resolved.placement].push(resolved.html)
      switch (asset.kind) {
        case 'script':
          hasExternalScript = true
          break
        case 'script-inline':
          // A data block is never executed, so it needs no grant and must not
          // push the page onto the script-running policy.
          if (!isExecutedInlineScript(asset.attrs)) break
          hasInlineScript = true
          inlineScriptHashes.add(`'sha256-${createHash('sha256').update(inlineScriptBody(asset.content)).digest('base64')}'`)
          break
        case 'style-inline':
          hasInlineStyle = true
          break
      }
    }
    if (runsCodeInVisitorBrowser(plugin)) {
      for (const host of plugin.manifest.networkAllowedHosts ?? []) {
        if (host) networkAllowedHostsSet.add(host)
      }
    }
    for (const host of plugin.manifest.frontend?.origins?.scripts ?? []) scriptOrigins.add(host)
    for (const host of plugin.manifest.frontend?.origins?.frames ?? []) frameOrigins.add(host)
  }

  return {
    tags,
    hasInlineScript,
    hasInlineStyle,
    hasExternalScript,
    networkAllowedHosts: [...networkAllowedHostsSet].sort(),
    inlineScriptHashes: [...inlineScriptHashes].sort(),
    scriptOrigins: [...scriptOrigins].sort(),
    frameOrigins: [...frameOrigins].sort(),
    mediaCspOrigins: await collectMediaAdapterCspOrigins(db),
  }
}

/**
 * Render a single declared asset to an HTML tag + placement bucket. Returns
 * `null` when the asset is malformed in a way the manifest validator missed
 * (defense in depth) or when an external asset is declared without a base
 * path (the publisher can't form a URL).
 */
function renderAsset(asset: FrontendAsset, plugin: InstalledPlugin): ResolvedTag | null {
  const placement = frontendAssetPlacement(asset)

  if (asset.kind === 'script') {
    const url = isExternalFrontendScriptSrc(asset.src)
      ? declaredExternalScriptUrl(plugin, asset.src)
      : resolveFrontendAssetUrl(plugin, asset.src)
    if (!url) return null
    const strategy = asset.strategy ?? 'defer'
    const strategyAttrs = scriptStrategyAttrs(strategy)
    const extra = formatAttrs(
      asset.attrs,
      strategy === 'module' ? MODULE_SCRIPT_HOST_OWNED_ATTRS : SCRIPT_HOST_OWNED_ATTRS,
    )
    const pluginAttr = ` data-plugin-id="${escapeAttr(plugin.manifest.id)}"`
    return {
      html: `<script src="${escapeAttr(url)}"${strategyAttrs}${extra}${pluginAttr}></script>`,
      placement,
    }
  }

  if (asset.kind === 'script-inline') {
    const extra = formatAttrs(asset.attrs, INLINE_SCRIPT_HOST_OWNED_ATTRS)
    const pluginAttr = ` data-plugin-id="${escapeAttr(plugin.manifest.id)}"`
    const body = inlineScriptBody(asset.content)
    return {
      html: `<script${extra}${pluginAttr}>${body}</script>`,
      placement,
    }
  }

  if (asset.kind === 'style') {
    const url = resolveFrontendAssetUrl(plugin, asset.href)
    if (!url) return null
    const extra = formatAttrs(asset.attrs, STYLESHEET_HOST_OWNED_ATTRS)
    const pluginAttr = ` data-plugin-id="${escapeAttr(plugin.manifest.id)}"`
    return {
      html: `<link rel="stylesheet" href="${escapeAttr(url)}"${extra}${pluginAttr}>`,
      placement,
    }
  }

  if (asset.kind === 'style-inline') {
    const extra = formatAttrs(asset.attrs)
    const pluginAttr = ` data-plugin-id="${escapeAttr(plugin.manifest.id)}"`
    const body = asset.content.replace(/<\/style/gi, '<\\/style')
    return {
      html: `<style${extra}${pluginAttr}>${body}</style>`,
      placement,
    }
  }

  if (asset.kind === 'link') {
    const extra = formatAttrs(asset.attrs)
    const pluginAttr = ` data-plugin-id="${escapeAttr(plugin.manifest.id)}"`
    return {
      html: `<link${extra}${pluginAttr}>`,
      placement,
    }
  }

  if (asset.kind === 'meta') {
    const extra = formatAttrs(asset.attrs)
    const pluginAttr = ` data-plugin-id="${escapeAttr(plugin.manifest.id)}"`
    return {
      html: `<meta${extra}${pluginAttr}>`,
      placement,
    }
  }

  // Defensive: should be unreachable because TypeScript narrows the union.
  return null
}

/**
 * The text emitted between `<script>` and `</script>`, which is also the text
 * hashed for the page policy. Two rewrites, both needed for the hash to match
 * what a browser computes:
 *   - CR LF and lone CR become LF. The HTML parser normalises newlines before
 *     the script's text exists, so a hash over the raw bytes of a CRLF script
 *     never matches and the script is blocked.
 *   - `</script` is escaped so the content cannot close the wrapping tag.
 */
function inlineScriptBody(content: string): string {
  return content.replace(/\r\n?/g, '\n').replace(/<\/script/gi, '<\\/script')
}

/**
 * The JavaScript MIME type essences (WHATWG MIME Sniffing). A `<script>` whose
 * type string is one of these, compared ASCII case-insensitively, is a
 * classic script.
 */
const JAVASCRIPT_MIME_ESSENCES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
])

/** Script types that are not JavaScript MIME types but that `script-src` still governs. */
const POLICY_GOVERNED_SCRIPT_TYPES = new Set(['module', 'importmap', 'speculationrules'])

/**
 * Whether a browser treats an inline `<script>` with these attributes as
 * something the page policy governs, following "prepare the script element"
 * in the HTML standard:
 *
 *   - `type=""`, or no `type` and no (or an empty) `language` → classic script.
 *   - `type` present → its value with leading and trailing ASCII whitespace
 *     stripped is the type string. No `type` but a non-empty `language` →
 *     the type string is `text/<language>`.
 *   - The type string is a classic script when it equals a JavaScript MIME
 *     type essence, and a module / import map / speculation rules when it
 *     equals that word, all ASCII case-insensitively. A type with parameters
 *     (`text/javascript; charset=utf-8`) equals none of them.
 *   - Anything else is a data block: never executed, not governed.
 *
 * `nomodule` is not consulted: a browser without module support runs such a
 * script, so it is hashed like any other.
 */
function isExecutedInlineScript(attrs: Record<string, string> | undefined): boolean {
  // A browser keeps the first of two attributes that differ only in case.
  const attr = (wanted: string): string | undefined =>
    Object.entries(attrs ?? {}).find(([name]) => name.toLowerCase() === wanted)?.[1]
  const type = attr('type')
  if (type === undefined) {
    const language = attr('language')
    if (language === undefined || language === '') return true
    return JAVASCRIPT_MIME_ESSENCES.has(`text/${language}`.toLowerCase())
  }
  if (type === '') return true
  const typeString = type.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase()
  return JAVASCRIPT_MIME_ESSENCES.has(typeString) || POLICY_GOVERNED_SCRIPT_TYPES.has(typeString)
}

/**
 * An absolute script address, but only when its host is one THIS plugin
 * declared in `frontend.origins.scripts`. The manifest parser enforces the
 * same rule at install; re-checking here means a stored manifest that
 * predates or sidesteps the parser still cannot emit a tag for an
 * undeclared host.
 */
function declaredExternalScriptUrl(plugin: InstalledPlugin, src: string): string | null {
  const host = externalFrontendScriptHost(src)
  if (!host) return null
  return frontendOriginAllowsHost(plugin.manifest.frontend?.origins?.scripts ?? [], host) ? src : null
}

/**
 * The anchor an asset is emitted at: its declared placement, else the per-kind
 * default. Scripts default to `body-end` so they don't block the parser;
 * styles, meta, link default to `head-end` so they're parsed before the body
 * renders.
 */
export function frontendAssetPlacement(asset: FrontendAsset): FrontendAssetPlacement {
  if (asset.placement) return asset.placement
  switch (asset.kind) {
    case 'script':
    case 'script-inline':
      return 'body-end'
    case 'style':
    case 'style-inline':
    case 'link':
    case 'meta':
      return 'head-end'
  }
}

function scriptStrategyAttrs(strategy: 'defer' | 'async' | 'module' | 'sync'): string {
  switch (strategy) {
    case 'defer':
      return ' defer'
    case 'async':
      return ' async'
    case 'module':
      return ' type="module"'
    case 'sync':
      return ''
  }
}

/**
 * Public URL of a package-relative asset path, under the plugin's own upload
 * directory. `null` when the manifest carries no `assetBasePath`.
 */
export function resolveFrontendAssetUrl(plugin: InstalledPlugin, relativePath: string): string | null {
  const base = plugin.manifest.assetBasePath
  if (!base) return null
  return `${base.replace(/\/+$/g, '')}/${relativePath.replace(/^\/+/g, '')}`
}

function formatAttrs(
  attrs: Record<string, string> | undefined,
  hostOwnedAttrs: ReadonlySet<string> = NO_HOST_OWNED_ATTRS,
): string {
  if (!attrs) return ''
  // data-plugin-id identifies every injected tag. Other host-owned attributes
  // are specific to the rendered tag kind, so bare link/meta tags and inline
  // assets retain the complete attrs bag they rely on.
  const parts: string[] = []
  for (const [name, value] of Object.entries(attrs)) {
    const normalizedName = name.toLowerCase()
    if (normalizedName === 'data-plugin-id' || hostOwnedAttrs.has(normalizedName)) continue
    parts.push(`${name}="${escapeAttr(value)}"`)
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`
}

// ---------------------------------------------------------------------------
// Splicer — apply a plan to a finished HTML document
// ---------------------------------------------------------------------------

/**
 * Inject every plan tag into the document at its placement anchor, and
 * rewrite the page CSP to match what the plan needs. Idempotent under
 * repeated passes — each anchor splice is a string replacement, not an
 * accumulator.
 *
 * Identical shape applies to both real-publish output and the editor's
 * preview iframe (`buildRuntimePreviewDocument`).
 */
export function injectFrontendAssets(
  html: string,
  injections: FrontendInjections,
): string {
  let next = html

  // Splice tags at each anchor in document order.
  if (injections.tags.head.length > 0) {
    const block = injections.tags.head.join('\n')
    // `head` means "as early as possible", which is right below the page's
    // policy: a `<meta>` policy does not govern what comes before it.
    next = insertAfterCspMeta(next, block)
      ?? (next.includes('<head>')
        ? next.replace('<head>', `<head>\n${block}`)
        : `${block}\n${next}`)
  }
  if (injections.tags['head-end'].length > 0) {
    const block = injections.tags['head-end'].join('\n')
    next = next.includes('</head>')
      ? next.replace('</head>', `${block}\n</head>`)
      : `${block}\n${next}`
  }
  if (injections.tags['body-start'].length > 0) {
    const block = injections.tags['body-start'].join('\n')
    next = /<body[^>]*>/i.test(next)
      ? next.replace(/<body([^>]*)>/i, `<body$1>\n${block}`)
      : `${block}\n${next}`
  }
  if (injections.tags['body-end'].length > 0) {
    const block = injections.tags['body-end'].join('\n')
    next = next.includes('</body>')
      ? next.replace('</body>', `${block}\n</body>`)
      : `${next}\n${block}`
  }

  return relaxCspForPlan(next, injections)
}

// ---------------------------------------------------------------------------
// CSP rewriting
// ---------------------------------------------------------------------------

/**
 * Merge every CSP relaxation this plan needs into the page policy in a single
 * deterministic pass. The CSP is modelled as data (`CspPlan`): we parse the
 * emitted `<meta>` once, mutate directive source sets, and re-serialize once
 * (`rewriteCspMeta`) — no per-directive regex surgery, no second pass, and the
 * output is byte-identical for identical inputs because `serializeCsp` sorts.
 *
 * Each relaxation is keyed on what the plan itself holds, so a plan that
 * needs nothing leaves the policy byte-identical.
 */
function relaxCspForPlan(html: string, plan: FrontendInjections): string {
  const needsPolicyChange =
    plan.hasExternalScript ||
    plan.hasInlineScript ||
    plan.hasInlineStyle ||
    plan.networkAllowedHosts.length > 0 ||
    plan.scriptOrigins.length > 0 ||
    plan.frameOrigins.length > 0 ||
    plan.mediaCspOrigins.length > 0
  if (!needsPolicyChange) return html

  return rewriteCspMeta(html, (csp) => {
    // Script: the published page's default CSP is `script-src 'none'`
    // (publisher emits clean HTML — visitor pages should run zero
    // host-supplied JS). Every tier ADDS to what the publisher emitted, so
    // the importmap hash and any module-JS grant survive:
    //   • External `<script src=…>` from `frontend.assets[]`        → `'self'`
    //     (sources live under `/uploads/plugins/<id>/<version>/…`,
    //     same origin as the page itself)
    //   • Executed inline `<script>` from `frontend.assets[]`       → `'self'`
    //     plus that script's own hash. Never `'unsafe-inline'`: with a hash
    //     in the policy a browser ignores it, and leaving it out keeps the
    //     rule honest (only declared inline scripts run).
    //   • Worker spawn from any plugin script → `worker-src 'self' blob:`
    if (plan.hasExternalScript || plan.hasInlineScript) {
      addCspSources(csp, 'script-src', ["'self'", ...plan.inlineScriptHashes])
      addCspSources(csp, 'worker-src', ["'self'", 'blob:'])
    }

    // Style: relax to `'unsafe-inline'` only when an inline style is present.
    if (plan.hasInlineStyle) {
      addCspSources(csp, 'style-src', ["'self'", "'unsafe-inline'"])
    }

    // Connect: union per-plugin `networkAllowedHosts`, plus the standard
    // `https:` for plugin frontend code that lazily-loads images. Not tied to
    // tags: a plugin whose module JS (or a `frontend.origins` script) makes
    // the request ships no tag of its own.
    if (plan.networkAllowedHosts.length > 0) {
      addCspSources(csp, 'connect-src', ["'self'", ...toCspHostSources(plan.networkAllowedHosts)])
      addCspSources(csp, 'img-src', ["'self'", 'data:', 'https:'])
    }

    // Third-party origins: what granted plugins declared in
    // `frontend.origins`.
    if (plan.scriptOrigins.length > 0) {
      addCspSources(csp, 'script-src', toCspHostSources(plan.scriptOrigins))
    }
    if (plan.frameOrigins.length > 0) {
      addCspSources(csp, 'frame-src', toCspHostSources(plan.frameOrigins))
    }

    // Media: union the origins declared by elected media storage adapters.
    // Runs regardless of whether any frontend plugin tag was injected — a site
    // can use an external storage backend without any frontend.assets plugin
    // being active. Extending `'self'` keeps the host-relative defaults
    // (`/uploads/*`, `/_instatic/*`) working.
    for (const { directive, origin } of plan.mediaCspOrigins) {
      addCspSources(csp, directive, ["'self'", `https://${origin}`])
    }
  })
}

/**
 * Translate manifest-style host patterns (`api.example.com`, `*.example.com`)
 * to CSP source expressions. CSP wildcards use `*.example.com` with the
 * scheme implicit — `https://*.example.com` is the safest form because the
 * publisher already forces HTTPS at the publish layer.
 */
function toCspHostSources(hosts: string[]): string[] {
  return hosts.map((host) => `https://${host}`)
}

/**
 * Only ELECTED adapters contribute — an installed-but-inactive adapter must
 * not pollute the published-page CSP.  An "elected" adapter is one that the
 * site admin has assigned to a specific media role (`original`, `variant`,
 * `avatar`, or `font`).  Adapters that are installed but not elected to any
 * role have no upload activity and therefore no CSP entitlement.
 */
async function collectMediaAdapterCspOrigins(
  db: DbClient,
): Promise<FrontendInjections['mediaCspOrigins']> {
  const elections = await listElectedAdapters(db)
  const seen = new Set<string>()
  const out: Array<{ directive: 'img-src' | 'media-src' | 'connect-src'; origin: string }> = []
  for (const election of elections) {
    if (!election.adapterId) continue
    const adapter = mediaStorageRegistry.resolveForRead(election.adapterId)
    if (!adapter || !adapter.cspOrigins) continue
    for (const entry of adapter.cspOrigins) {
      const key = `${entry.directive}|${entry.origin}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Attribute escaping
// ---------------------------------------------------------------------------

function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
