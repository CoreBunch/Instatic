/**
 * Publisher — page orchestrator.
 *
 * Converts a Page (flat-map PageNode tree) into a clean, standalone HTML
 * document. The walker, escapers, class injectors, and specialised renderers
 * live in sibling files (`renderNode.ts`, `escapeProps.ts`, `classInjection.ts`,
 * `renderVisualComponentRef.ts`, `renderLoop.ts`). This file's job is the
 * page-level concerns the walker doesn't care about:
 *
 *   - template-context defaulting (page / site / route frames)
 *   - `<body>`-tag class injection from the root node's classIds
 *   - `<head>` meta tags (title, description, favicon, lang)
 *   - runtime asset `<script>` tags + the importmap
 *   - Content-Security-Policy `<meta>` tag
 *   - inline `<style>` block OR `<link>` tags for the site CSS bundle
 *   - final document assembly
 *
 * Each concern lives in its own helper. `publishPage` is straight-line
 * orchestration: adding a new head feature means editing one helper, not
 * threading another ternary through 150 lines.
 */

import type { Page, SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { buildPageFrame, buildSiteFrame, buildRouteFrame } from '@core/templates/contextFrames'
import { classNamesForClassIds } from '@core/page-tree'
import {
  normalizeHtmlAttributeName,
  sanitizeRenderableHtmlAttribute,
} from '@core/htmlAttributes'
import { bagToInlineStyle } from './classCss'
import { collectClassCSS, sanitizeModuleCSS } from './cssCollector'
import { collectUserStylesheetCss } from './userStylesheets'
import { PUBLISHER_RESET_CSS } from './reset'
import { buildSiteFrameworkCss } from './frameworkCss'
import type { SiteCssBundle } from './siteCssBundle'
import { escapeHtml, isSafeUrl } from './utils'
import { addCspSources, createBaseCspPlan, cspMetaTag } from './cspPlan'
import type { PublishedPageRuntimeAssets } from '@core/site-runtime/schemas'
import { hasPublishedRuntimeScripts, scriptTagsForRuntimeAssets } from '@core/site-runtime'
import { renderNode } from './renderNode'
import { findDynamicNodeIds } from './dynamicDetection'
import { collectHoleSubtreeModuleIds } from './holeSubtreeModules'
import type {
  RenderConfig,
  RenderAccumulators,
  RenderResolvedMedia,
  ResolvedLoopRenderData,
} from './renderConfig'

interface PublishedPage {
  /** Filename for this page in the ZIP archive, e.g. "index.html", "about-us.html" */
  filename: string
  /** Complete <!DOCTYPE html> document — no editor dependencies */
  html: string
  /**
   * Sorted module-JS CANDIDATES for this page: moduleIds that emitted `js`
   * during this render ∪ every moduleId inside this page's hole subtrees.
   * The server intersects this with the site module-JS map before injecting
   * `<script>` tags (see `server/publish/moduleJsBundle.ts`).
   */
  jsModuleIds: string[]
}

interface PublishPageOptions {
  breakpointId?: string
  templateContext?: TemplateRenderDataContext
  runtimeAssets?: PublishedPageRuntimeAssets
  /**
   * Pre-fetched data for every `base.loop` node on the page, keyed by
   * loop nodeId. Produced server-side by `prefetchLoopData()` before
   * publishing. Loops without an entry here render an empty string in
   * the published page (and an HTML comment in dev/preview).
   */
  loopData?: Map<string, ResolvedLoopRenderData>
  /**
   * Pre-fetched media assets keyed by `public_path`. Produced server-side
   * by `prefetchMediaAssets()` before publishing. Lets the publisher
   * attach the resolved variant ladder / BlurHash / dimensions to each
   * image-prop'd node so the module render() can emit responsive markup
   * without any I/O of its own.
   */
  mediaAssets?: Map<string, RenderResolvedMedia>
  /**
   * Optional URL hint for the loop runtime — used to construct
   * "Load more" endpoint URLs in `data-instatic-loop-endpoint` attributes
   * when the page contains an infinite-mode loop. Defaults to
   * `/_instatic/loop/`.
   */
  loopEndpointBaseUrl?: string
  /**
   * How site-wide CSS (reset, framework, user classes) is emitted into the
   * published HTML.
   *
   * - `'inline'` (default): one `<style>` block in `<head>` containing reset +
   *   framework CSS (variables + generated utilities) + module CSS + user
   *   class CSS. Best for self-contained exports, the iframe runtime preview,
   *   and tests.
   * - `'external'`: emits up to four `<link rel="stylesheet">` tags pointing at the
   *   pre-built site CSS bundle (`/_instatic/css/<filename>`). The HTML stays small,
   *   the bundles are content-hashed for `Cache-Control: immutable` reuse
   *   across page navigations. Pass `cssBundle` + `cssAssetBaseUrl` to use this
   *   mode.
   *
   * In external mode any per-page module CSS that would have been inlined is
   * skipped here — it's assumed to live in `cssBundle.framework.content`,
   * which is what `buildSiteCssBundle()` produces. This keeps every visitor's
   * four CSS files cacheable.
   */
  cssEmission?: 'inline' | 'external'
  /**
   * Pre-built site CSS bundle. Required when `cssEmission === 'external'`.
   * Computed once per published-snapshot via `buildSiteCssBundle(site, registry)`.
   */
  cssBundle?: SiteCssBundle
  /**
   * Base URL prepended to each bundle filename to form the `<link href>`
   * value, e.g. `'/_instatic/css/'`. Defaults to `'/_instatic/css/'`.
   */
  cssAssetBaseUrl?: string
  /**
   * Pre-serialised `<script type="importmap">` body + its SHA-256 hash.
   *
   * Emitted in `<head>` and the hash is added to the page's CSP
   * `script-src` so the inline tag passes a strict policy. Built on the
   * server side from the site's locked runtime dependencies + the populated
   * `bun install` cache — plugins use bare imports like
   * `import * as THREE from 'three'` and the browser resolves them to
   * `/_instatic/runtime/cache/<hash>/...` paths served from the host.
   */
  runtimePackageImportmap?: PublishedRuntimePackageImportmap
  /**
   * Monotonic publish version from `server/publish/publishState.ts`.
   * Stamped into every `<instatic-hole data-instatic-version>` attribute so the hole
   * runtime can detect stale placeholders after a re-publish. Pass
   * `getPublishVersion()` from `publishState.ts` at the call site — this
   * keeps `src/core/publisher/` free of imports from `server/`.
   * Defaults to `0` when omitted (holes will always get a stale response
   * on first fetch, which is safe — the next page load sees the real version).
   */
  publishVersion?: number
  /**
   * Editor-only: annotate each node's outermost emitted element with
   * `uid="<id>"`. Default off — real publishes emit clean, id-less
   * HTML. Used by the agent read-surface (read_document) to produce an
   * HTML representation the agent targets nodes through.
   */
  annotateNodeIds?: boolean
}

/**
 * Pre-serialised importmap + the SHA-256 of its body, ready to drop into
 * `<head>` and `Content-Security-Policy`. Computed once on the server by
 * `buildRuntimePackageImportmap` so the body the browser hashes matches the
 * body we hash for the CSP directive.
 */
export interface PublishedRuntimePackageImportmap {
  /** Exact JSON text emitted inside `<script type="importmap">…</script>`. */
  body: string
  /** Base64-encoded SHA-256 of `body` — used as `'sha256-<value>'` in CSP. */
  sha256: string
}

/**
 * Build the `<style>` block (inline mode) or `<link>` tags (external mode)
 * that go into `<head>`.
 *
 * Cascade order is identical in both modes: reset → framework (tokens +
 * generated utilities + module CSS) → user class CSS. User class CSS loads
 * last so it wins specificity ties — same behaviour as the previous
 * in-`<style>` cascade.
 */
function buildStyleHead(
  cssEmission: 'inline' | 'external',
  options: PublishPageOptions,
  site: SiteDocument,
  page: Page,
  cssMap: Map<string, string>,
): string {
  if (cssEmission === 'external') {
    if (!options.cssBundle) {
      throw new Error('publishPage: cssEmission "external" requires options.cssBundle')
    }
    const baseUrl = options.cssAssetBaseUrl ?? '/_instatic/css/'
    // Order matters — source order resolves specificity ties. User-authored
    // global stylesheets load LAST so they win against the class registry,
    // and the class registry wins against framework utilities.
    const links = [
      options.cssBundle.reset,
      options.cssBundle.framework,
      options.cssBundle.style,
      options.cssBundle.userStyles,
    ]
      // Skip empty bundles — emitting `<link>` to a 0-byte file is a wasted
      // request. `framework.css`, `style.css`, and `userStyles.css` are
      // routinely empty on a fresh site (no framework configured, no
      // classes defined, no user-authored CSS files).
      .filter((file) => file.content.length > 0)
      .map((file) => `  <link rel="stylesheet" href="${escapeHtml(baseUrl + file.filename)}">`)
      .join('\n')
    return links ? `${links}\n` : ''
  }

  const frameworkCss = buildSiteFrameworkCss(site)
  const moduleCss = Array.from(cssMap.values()).join('\n')
  const classCss = collectClassCSS(site, { mediaAssets: options.mediaAssets })
  const userCss = collectUserStylesheetCss(site, page)
  // Same cascade order as the external-link path: user CSS comes last so it
  // wins specificity ties against the class registry. Neutralise `</style>` in
  // the full assembled CSS so no source (user stylesheet or framework CSS) can
  // break out of the <style> element (ISS-007). sanitizeModuleCSS is idempotent,
  // so re-running it over already-sanitised module CSS is harmless.
  const allCss = sanitizeModuleCSS(
    [PUBLISHER_RESET_CSS, frameworkCss, moduleCss, classCss, userCss].filter(Boolean).join('\n'),
  )
  return `  <style>\n${allCss}\n  </style>\n`
}

/**
 * Convert a page title/slug to a safe HTML filename.
 * "About Us" → "about-us.html", "index" → "index.html"
 */
function slugToFilename(slug: string, title: string): string {
  const base = (slug || title || 'page')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return base === '' || base === 'index' ? 'index.html' : `${base}.html`
}

/**
 * Seed the page/site/route frames a caller may have omitted from its
 * TemplateRenderDataContext. Every published page needs all four frames
 * populated so dynamic bindings against those sources resolve — even on
 * plain (non-template, non-loop) pages. Caller-provided values always
 * win; missing slots fall back to defaults derived from the page/site.
 */
function composeTemplateContext(
  page: Page,
  site: SiteDocument,
  incoming: TemplateRenderDataContext | undefined,
): TemplateRenderDataContext {
  const provided = incoming ?? { entryStack: [] }
  const pageFrame = provided.page ?? buildPageFrame(page)
  return {
    entryStack: provided.entryStack,
    page: pageFrame,
    site: provided.site ?? buildSiteFrame(site),
    route: provided.route ?? buildRouteFrame(pageFrame.permalink),
  }
}

/**
 * Compute the `<body>` opening tag, lifting user class names from the
 * root PageNode onto `<body>` directly. base.body emits no wrapper
 * element, so root-level classIds belong on `<body>` itself — clean HTML
 * with no freeloader `<div>`.
 */
function computeBodyOpenTag(
  page: Page,
  site: SiteDocument,
  mediaAssets?: Map<string, RenderResolvedMedia>,
): string {
  const rootNode = page.nodes[page.rootNodeId]
  if (!rootNode) return '<body>'

  const classAttr = rootNode.classIds?.length
    ? classNamesForClassIds(site.styleRules, rootNode.classIds).map(escapeHtml).join(' ')
    : ''
  // base.body emits no wrapper, so the root node's inline styles also belong
  // on <body> itself (same reasoning as classIds above).
  const styleAttr = rootNode.inlineStyles
    ? escapeHtml(bagToInlineStyle(rootNode.inlineStyles, { mediaAssets }))
    : ''
  const htmlAttrs = bodyHtmlAttributes(rootNode.props.htmlAttributes)

  const attrs =
    htmlAttrs +
    (classAttr ? ` class="${classAttr}"` : '') + (styleAttr ? ` style="${styleAttr}"` : '')
  return `<body${attrs}>`
}

function bodyHtmlAttributes(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  return Object.entries(value)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([rawName, rawValue]) => {
      if (typeof rawValue !== 'string') return ''
      const name = normalizeHtmlAttributeName(rawName)
      const safeValue = sanitizeRenderableHtmlAttribute(name, rawValue)
      if (safeValue === null) return ''
      return ` ${name}="${escapeHtml(safeValue)}"`
    })
    .join('')
}

/**
 * `<head>` metadata tags derived from site settings + page.
 *
 * - `title` falls back through metaTitle → page.title → site.name.
 * - URL-typed settings (faviconUrl) are validated by
 *   isSafeUrl() (blocks `javascript:` / `vbscript:` schemes) and then
 *   escapeHtml()'d for safe attribute interpolation.
 * - `lang` honours WCAG 2.1 AA SC 3.1.1 and escapes the BCP-47 tag
 *   because settings.language is user-controlled.
 */
interface DocumentMetaTags {
  pageTitle: string
  metaDesc: string
  favicon: string
  langAttr: string
}

function buildDocumentMetaTags(site: SiteDocument, page: Page): DocumentMetaTags {
  const { settings } = site
  const metaDesc = settings.metaDescription
    ? `\n  <meta name="description" content="${escapeHtml(settings.metaDescription)}">`
    : ''
  const favicon =
    settings.faviconUrl && isSafeUrl(settings.faviconUrl)
      ? `\n  <link rel="icon" href="${escapeHtml(settings.faviconUrl)}">`
      : ''
  return {
    pageTitle: escapeHtml(settings.metaTitle ?? page.title ?? site.name),
    metaDesc,
    favicon,
    langAttr: escapeHtml(settings.language ?? 'en'),
  }
}

/**
 * Runtime / importmap / loop-runtime `<script>` tags + the flags the CSP
 * builder needs. Centralising every "do we need a script tag?" branch in
 * one place keeps publishPage straight-line and makes adding a new
 * head-or-body-end runtime asset a single-file change.
 */
interface RuntimeAssetsBlock {
  headRuntimeScripts: string
  bodyEndRuntimeScripts: string
  loopRuntimeScript: string
  /** `<script type="module" src="/_instatic/hole-runtime.js" defer>` or empty string. */
  holeRuntimeScript: string
  importmapTag: string
  importmap: PublishedRuntimePackageImportmap | undefined
  anyScriptTag: boolean
}

function buildRuntimeAssetsBlock(
  options: PublishPageOptions,
  acc: RenderAccumulators,
): RuntimeAssetsBlock {
  const { runtimeAssets } = options
  const headRuntimeScripts = scriptTagsForRuntimeAssets(runtimeAssets, 'head')
  const bodyEndRuntimeScripts = scriptTagsForRuntimeAssets(runtimeAssets, 'body-end')
  const hasRuntimeScripts = hasPublishedRuntimeScripts(runtimeAssets)

  // Loop runtime is a self-hosted script bundle served at a known fixed
  // path; only injected when at least one loop on the page uses
  // pagination='infinite'. This keeps the "no JS by default" line for
  // pages that don't need it.
  const hasInfiniteLoops = acc.infiniteLoopIds.size > 0
  const loopEndpointBaseUrl = options.loopEndpointBaseUrl ?? '/_instatic/loop/'
  const loopRuntimeScript = hasInfiniteLoops
    ? `  <script type="module" src="/_instatic/assets/loop-runtime.js" data-instatic-loop-endpoint="${escapeHtml(loopEndpointBaseUrl)}" defer></script>`
    : ''

  // Hole runtime — injected into <head> (not body-end) so IntersectionObserver
  // registration runs as early as possible. Only emitted when at least one hole
  // was actually rendered during the walk (tracked via acc.holeNodeIds) — no
  // idle JS for fully-static pages.
  const hasHoles = acc.holeNodeIds.size > 0
  // Version the runtime URL with publishVersion so a CMS update busts the
  // browser cache (the asset is served `max-age=3600`); the runtime endpoint
  // ignores the query string.
  const holeRuntimeScript = hasHoles
    ? `  <script type="module" src="/_instatic/hole-runtime.js?v=${options.publishVersion ?? 0}" defer></script>`
    : ''

  // Site-dependency importmap. When present we emit a `<script type="importmap">`
  // tag in `<head>` (must precede any `<script type="module">`) and pin its
  // SHA-256 into `script-src` so the inline tag passes strict CSP.
  const importmap = options.runtimePackageImportmap
  const importmapTag = importmap
    ? `  <script type="importmap">${importmap.body}</script>`
    : ''

  return {
    headRuntimeScripts,
    bodyEndRuntimeScripts,
    loopRuntimeScript,
    holeRuntimeScript,
    importmapTag,
    importmap,
    anyScriptTag: hasRuntimeScripts || hasInfiniteLoops || hasHoles || Boolean(importmap),
  }
}

/**
 * Build the Content-Security-Policy `<meta>` tag (Constraint #227).
 *
 * The policy is modelled as a `CspPlan` (see `./cspPlan`) and serialized with
 * deterministic ordering, so the same inputs always emit a byte-identical tag.
 * `script-src` defaults to `'none'`; if any script tag is on the page it
 * relaxes to `'self'` (runtime cache URLs live under the same origin). The
 * inline importmap additionally needs its base64 SHA-256 listed so strict CSP
 * doesn't reject it. The server-side injection pipeline merges plugin / media /
 * form-runtime sources into this same plan downstream.
 */
function buildContentSecurityPolicy(
  anyScriptTag: boolean,
  importmap: PublishedRuntimePackageImportmap | undefined,
  moduleCspSources: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  const plan = createBaseCspPlan({ anyScriptTag, importmapSha: importmap?.sha256 })
  // Merge per-page CSP requirements declared by module render() outputs.
  // addCspSources automatically drops the lone 'none' when real sources are
  // added, so frame-src 'none' becomes frame-src <origins> on pages that
  // embed external iframes (e.g. YouTube). Pages with no such embeds are
  // unaffected and keep frame-src 'none'.
  for (const [directive, sources] of moduleCspSources) {
    addCspSources(plan, directive, sources)
  }
  return `\n  ${cspMetaTag(plan)}`
}

/**
 * Optional `<head>` / body-end line that must be omitted entirely when
 * the source string is empty. Keeps the assembled HTML free of stray
 * blank lines when a section has no content.
 */
function lineOrEmpty(content: string): string {
  return content ? `${content}\n` : ''
}

interface AssembledDocumentParts {
  langAttr: string
  csp: string
  pageTitle: string
  metaDesc: string
  favicon: string
  styleHeadHtml: string
  importmapTag: string
  headRuntimeScripts: string
  /** `<script type="module" src="/_instatic/hole-runtime.js" defer>` or empty. */
  holeRuntimeScript: string
  bodyOpenTag: string
  bodyHtml: string
  bodyEndRuntimeScripts: string
  loopRuntimeScript: string
}

function assembleHtmlDocument(parts: AssembledDocumentParts): string {
  return (
    `<!DOCTYPE html>\n` +
    `<html lang="${parts.langAttr}">\n` +
    `<head>\n` +
    `  <meta charset="UTF-8">\n` +
    `  <meta name="viewport" content="width=device-width, initial-scale=1.0">${parts.csp}\n` +
    `  <title>${parts.pageTitle}</title>${parts.metaDesc}${parts.favicon}\n` +
    parts.styleHeadHtml +
    lineOrEmpty(parts.importmapTag) +
    lineOrEmpty(parts.headRuntimeScripts) +
    lineOrEmpty(parts.holeRuntimeScript) +
    `</head>\n` +
    `${parts.bodyOpenTag}\n` +
    `${parts.bodyHtml}\n` +
    lineOrEmpty(parts.bodyEndRuntimeScripts) +
    lineOrEmpty(parts.loopRuntimeScript) +
    `</body>\n` +
    `</html>`
  )
}

/**
 * Publish a single page to a standalone HTML document.
 *
 * - Walks the node tree bottom-up, collecting HTML and CSS.
 * - Deduplicates CSS across all nodes (one entry per moduleId).
 * - Injects site design tokens as CSS :root custom properties.
 * - Embeds the deduplicated CSS in a single <style> block — no external stylesheets.
 * - No editor code, no React, no framework runtime in the output.
 *
 * Each `<head>` / body concern lives in its own helper (template-context
 * defaulting, body-tag class injection, meta tags, runtime assets, CSP,
 * document assembly). This function is straight-line orchestration:
 * adding a new head feature means editing one helper, not threading
 * another ternary through 150 lines.
 */
export function publishPage(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
  options: PublishPageOptions = {},
): PublishedPage {
  // Layer C: classify every node as static or dynamic before walking the tree.
  // Dynamic node ids are threaded into the RenderConfig so renderNode can
  // emit <instatic-hole> placeholders instead of recursing.
  const dynamicNodeIds = findDynamicNodeIds(page, site, registry)

  // Read-only inputs of this render pass. A renderer that needs a different
  // page (VC ref) or template frame (loop iteration) derives a child config —
  // it never mutates this one.
  const config: RenderConfig = {
    page,
    site,
    registry,
    breakpointId: options.breakpointId,
    templateContext: composeTemplateContext(page, site, options.templateContext),
    loopData: options.loopData,
    mediaAssets: options.mediaAssets,
    dynamicNodeIds: dynamicNodeIds.size > 0 ? dynamicNodeIds : undefined,
    publishVersion: options.publishVersion ?? 0,
    annotateNodeIds: options.annotateNodeIds,
  }

  // Mutable outputs, owned here and threaded by reference through the whole
  // walk. All five are initialised up-front (no lazy undefined): the walk
  // appends module CSS to `cssMap`, module JS to `jsMap`, infinite-loop ids
  // to `infiniteLoopIds`, and the ids of nodes that actually emitted a
  // `<instatic-hole>` to `holeNodeIds`. After the walk, the head builders
  // read their `.size`.
  const acc: RenderAccumulators = {
    cssMap: new Map<string, string>(),
    jsMap: new Map<string, string>(),
    cspSources: new Map<string, Set<string>>(),
    infiniteLoopIds: new Set<string>(),
    holeNodeIds: new Set<string>(),
  }

  // Render entire tree from root. The walker also accumulates module CSS
  // into `acc.cssMap`; in external mode that result is discarded because the
  // same data is already in the pre-built `framework.css` bundle.
  const bodyHtml = renderNode(page.rootNodeId, config, acc)

  // Per-page module-JS candidates: render-emitted ids ∪ static hole-subtree
  // ids. Hole subtrees are NOT rendered here, so the static walk is the only
  // way to know what their request-time fragments will need.
  const jsModuleIds = [
    ...new Set([
      ...acc.jsMap.keys(),
      ...collectHoleSubtreeModuleIds(page, site, dynamicNodeIds),
    ]),
  ].sort()

  // Cascade order (both inline/external): reset → framework (tokens +
  // generated utilities + module CSS) → user class CSS. User classes load
  // last so they win specificity ties on identically-specific selectors.
  const styleHeadHtml = buildStyleHead(
    options.cssEmission ?? 'inline',
    options,
    site,
    page,
    acc.cssMap,
  )

  const meta = buildDocumentMetaTags(site, page)
  const runtime = buildRuntimeAssetsBlock(options, acc)
  const csp = buildContentSecurityPolicy(runtime.anyScriptTag, runtime.importmap, acc.cspSources)

  const html = assembleHtmlDocument({
    langAttr: meta.langAttr,
    csp,
    pageTitle: meta.pageTitle,
    metaDesc: meta.metaDesc,
    favicon: meta.favicon,
    styleHeadHtml,
    importmapTag: runtime.importmapTag,
    headRuntimeScripts: runtime.headRuntimeScripts,
    holeRuntimeScript: runtime.holeRuntimeScript,
    bodyOpenTag: computeBodyOpenTag(page, site, options.mediaAssets),
    bodyHtml,
    bodyEndRuntimeScripts: runtime.bodyEndRuntimeScripts,
    loopRuntimeScript: runtime.loopRuntimeScript,
  })

  return {
    filename: slugToFilename(page.slug, page.title),
    html,
    jsModuleIds,
  }
}
