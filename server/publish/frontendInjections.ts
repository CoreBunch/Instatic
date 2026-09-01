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
 *   5. Relax the page CSP based on what the plan actually contains:
 *        - inline script → `script-src` gets `'unsafe-inline'`
 *        - inline style  → `style-src`  gets `'unsafe-inline'`
 *        - external script/style: no relaxation needed (same-origin / allowlisted)
 *        - plugin-declared `networkAllowedHosts` → appended to `connect-src`
 *      Pure-meta plans get no CSP changes.
 *
 * Pure data assembly — no DOM, no fetch. Called from a single place at the
 * dispatcher (`server/router.ts → tryServePublishedPage / tryServeContentRoute`),
 * so every HTML-emitting render path gets the same treatment.
 */

import type { DbClient } from '../db/client'
import {
  listInstalledPlugins,
  listPluginRecords,
  type InstalledPluginResult,
} from '../repositories/plugins'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { listElectedAdapters } from '../repositories/mediaStorageAdapters'
import { addCspSources, rewriteCspMeta, setCspDirective } from '@core/publisher'
import type {
  FrontendAsset,
  FrontendAssetPlacement,
  InstalledPlugin,
  PluginCspContribution,
} from '@core/plugin-sdk'
import { validatePluginCspContributionRecord } from '@core/plugins/manifest'

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

const PLACEMENT_ORDER: ReadonlyArray<FrontendAssetPlacement> = [
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
   * Whether any inline `<script>` tag is present in the plan. When true,
   * the page CSP gets `script-src 'unsafe-inline'`.
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
   * Union of `networkAllowedHosts` declared by every enabled plugin that
   * contributed any frontend asset. Appended to the page CSP's
   * `connect-src` so visitor-side `fetch()` from plugin frontend code
   * reaches the hosts the manifest declared.
   */
  networkAllowedHosts: string[]
  /**
   * CSP origins declared by elected media storage adapters. Appended to
   * `img-src` / `media-src` / `connect-src` so the browser can load assets
   * from the adapter's backend.
   */
  mediaCspOrigins: ReadonlyArray<{
    directive: 'img-src' | 'media-src' | 'connect-src'
    origin: string
  }>
  /** Validated, additive site-wide sources contributed by enabled plugins. */
  cspSources: PluginCspContribution[]
}

// ---------------------------------------------------------------------------
// Collection — walk installed plugins, build a plan
// ---------------------------------------------------------------------------

export async function collectFrontendInjections(db: DbClient): Promise<FrontendInjections> {
  const results = await listInstalledPlugins(db)
  const tags: Record<FrontendAssetPlacement, string[]> = {
    'head': [],
    'head-end': [],
    'body-start': [],
    'body-end': [],
  }
  const networkAllowedHostsSet = new Set<string>()
  let hasInlineScript = false
  let hasInlineStyle = false
  let hasExternalScript = false

  // Broken plugins (corrupt manifest_json) have no parseable frontend assets —
  // skip them entirely. Only ok-parsed, enabled, non-error plugins contribute.
  const okPlugins = results
    .filter((r): r is Extract<InstalledPluginResult, { kind: 'ok' }> => r.kind === 'ok')
    .map((r) => r.plugin)

  // Sort by plugin id so the emitted tag order is deterministic across
  // re-renders. Two plugins declaring the same placement get a stable
  // top-down emission.
  const eligible = okPlugins
    .filter((p) => p.enabled && p.lifecycleStatus !== 'error')
    .filter((p) => new Set(p.grantedPermissions).has('frontend.assets'))
    .filter((p) => (p.manifest.frontend?.assets ?? []).length > 0)
    .sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0))

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
          hasInlineScript = true
          break
        case 'style-inline':
          hasInlineStyle = true
          break
      }
    }
    for (const host of plugin.manifest.networkAllowedHosts ?? []) {
      if (host) networkAllowedHostsSet.add(host)
    }
  }

  return {
    tags,
    hasInlineScript,
    hasInlineStyle,
    hasExternalScript,
    networkAllowedHosts: [...networkAllowedHostsSet].sort(),
    mediaCspOrigins: await collectMediaAdapterCspOrigins(db),
    cspSources: await collectPluginCspSources(db, okPlugins),
  }
}

async function collectPluginCspSources(
  db: DbClient,
  plugins: InstalledPlugin[],
): Promise<PluginCspContribution[]> {
  const keyed = new Map<string, PluginCspContribution>()
  const eligible = plugins
    .filter((plugin) => plugin.enabled && plugin.lifecycleStatus !== 'error')
    .filter((plugin) => plugin.grantedPermissions.includes('publisher.csp'))
    .filter((plugin) => plugin.manifest.publisher?.csp)
    .sort((a, b) => a.id.localeCompare(b.id))

  for (const plugin of eligible) {
    const resourceId = plugin.manifest.publisher?.csp.resource
    if (!resourceId) continue
    const { records } = await listPluginRecords(db, plugin.id, resourceId, { limit: 1000 })
    for (const record of records) {
      try {
        const contribution = validatePluginCspContributionRecord(record.data)
        if (!contribution.enabled) continue
        keyed.set(`${contribution.directive}\u0000${contribution.origin}`, contribution)
      } catch (err) {
        // Persisted rows are untrusted storage input. Fail closed per row so a
        // corrupt legacy value cannot weaken or break the site's policy.
        console.error(`[plugin:${plugin.id}] ignored invalid CSP contribution:`, err)
      }
    }
  }

  return [...keyed.values()].sort((a, b) => {
    const aKey = `${a.directive}\u0000${a.origin}`
    const bKey = `${b.directive}\u0000${b.origin}`
    return aKey.localeCompare(bKey)
  })
}

/**
 * Render a single declared asset to an HTML tag + placement bucket. Returns
 * `null` when the asset is malformed in a way the manifest validator missed
 * (defense in depth) or when an external asset is declared without a base
 * path (the publisher can't form a URL).
 */
function renderAsset(asset: FrontendAsset, plugin: InstalledPlugin): ResolvedTag | null {
  const placement = asset.placement ?? defaultPlacement(asset)

  if (asset.kind === 'script') {
    const url = resolveAssetUrl(plugin, asset.src)
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
    // Inline `</script>` would close the wrapping tag. Standard escape.
    const body = asset.content.replace(/<\/script/gi, '<\\/script')
    return {
      html: `<script${extra}${pluginAttr}>${body}</script>`,
      placement,
    }
  }

  if (asset.kind === 'style') {
    const url = resolveAssetUrl(plugin, asset.href)
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
 * Per-kind default placement when the asset declaration omits it. Scripts
 * default to `body-end` so they don't block the parser; styles, meta, link
 * default to `head-end` so they're parsed before the body renders.
 */
function defaultPlacement(asset: FrontendAsset): FrontendAssetPlacement {
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

function resolveAssetUrl(plugin: InstalledPlugin, relativePath: string): string | null {
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
    next = next.includes('<head>')
      ? next.replace('<head>', `<head>\n${block}`)
      : `${block}\n${next}`
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

  const hasTagWork = PLACEMENT_ORDER.some((p) => injections.tags[p].length > 0)
  if (hasTagWork || injections.mediaCspOrigins.length > 0 || injections.cspSources.length > 0) {
    next = relaxCspForPlan(next, injections, hasTagWork)
  }
  return next
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
 * `hasTags` gates the plugin-tag relaxations (script / style / connect) so a
 * media-only plan touches only the media directives — preserving the original
 * two-function gating.
 */
function relaxCspForPlan(html: string, plan: FrontendInjections, hasTags: boolean): string {
  return rewriteCspMeta(html, (csp) => {
    if (hasTags) {
      // Script: the published page's default CSP is `script-src 'none'`
      // (publisher emits clean HTML — visitor pages should run zero
      // host-supplied JS). Relaxation tiers:
      //   • External `<script src=…>` from `frontend.assets[]`        → `'self'`
      //     (sources live under `/uploads/plugins/<id>/<version>/…`,
      //     same origin as the page itself)
      //   • Inline `<script>` from `frontend.assets[]: 'script-inline'` → also
      //     adds `'unsafe-inline'` on top
      //   • Worker spawn from any plugin script → relax `worker-src`
      //     to `'self' blob:`
      if (plan.hasExternalScript || plan.hasInlineScript) {
        setCspDirective(
          csp,
          'script-src',
          plan.hasInlineScript ? ["'self'", "'unsafe-inline'"] : ["'self'"],
        )
        setCspDirective(csp, 'worker-src', ["'self'", 'blob:'])
      }

      // Style: relax to `'unsafe-inline'` only when an inline style is present.
      if (plan.hasInlineStyle) {
        setCspDirective(csp, 'style-src', ["'self'", "'unsafe-inline'"])
      }

      // Connect: union per-plugin `networkAllowedHosts`, plus the standard
      // `https:` for plugin frontend code that lazily-loads images.
      if (plan.networkAllowedHosts.length > 0) {
        addCspSources(csp, 'connect-src', ["'self'", ...toCspHostSources(plan.networkAllowedHosts)])
        addCspSources(csp, 'img-src', ["'self'", 'data:', 'https:'])
      }
    }

    // Media: union the origins declared by elected media storage adapters.
    // Runs regardless of whether any frontend plugin tag was injected — a site
    // can use an external storage backend without any frontend.assets plugin
    // being active. Extending `'self'` keeps the host-relative defaults
    // (`/uploads/*`, `/_instatic/*`) working.
    for (const { directive, origin } of plan.mediaCspOrigins) {
      addCspSources(csp, directive, ["'self'", `https://${origin}`])
    }

    // Publisher CSP contributions are always additive. The record shape has
    // no replace/remove operation, and the host validator admits only an exact
    // directive allowlist plus canonical HTTPS origins.
    for (const { directive, origin } of plan.cspSources) {
      addCspSources(csp, directive, [origin])
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
