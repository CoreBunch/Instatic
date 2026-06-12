/**
 * assetPlan — collect asset references from page fragments and CSS rules,
 * then normalise all URL-shaped values in the plan to FileMap keys so that
 * `applyAssetRewrites` can do exact-string replacement.
 *
 * Two sources of asset references:
 *   1. PageNode props — `src`, `href`, `srcset` values set by the HTML
 *      importer from element attributes, plus imported `htmlAttributes` bags
 *      such as `data-bg-src`.
 *   2. CSS rule styles — `url(...)` payloads recorded by Phase 1's
 *      `cssToStyleRules` in the returned `AssetRef[]`.
 *
 * After normalisation:
 *   - URL-shaped props in node fragments are replaced with their FileMap key
 *     (e.g. `"./images/hero.png"` → `"images/hero.png"`).
 *   - CSS `url('...')` expressions inside styles and contextStyles are
 *     rewritten to hold the FileMap key as the URL payload.
 *   - External URLs (`http://`, `https://`, `//`, `data:`, `mailto:`, `tel:`,
 *     `#fragment`) are left unchanged.
 *
 * The normalised pagePlans and styleRules are returned alongside the deduplicated
 * asset list; only files present in the FileMap are included.
 */

import { dirname, joinPaths } from './paths'
import type { PageNode } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'
import type { FontFileFormat } from '@core/fonts'
import type {
  FileMap,
  ImportWarning,
  PagePlan,
  AssetRef,
  NewStyleRule,
  ParsedFontFace,
  ImportFontFamily,
  ImportFontFile,
  ImportStylesheet,
} from './types'
import { guessMimeType, isImportUploadableMimeType } from './mimeTypes'

// ---------------------------------------------------------------------------
// Props that may contain relative asset URLs in page nodes
// ---------------------------------------------------------------------------

const URL_BEARING_PROPS: ReadonlySet<string> = new Set(['src', 'href', 'srcset'])

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CssFileResult {
  /** FileMap key of the CSS source file. */
  cssPath: string
  /** Rules produced by cssToStyleRules for this file. */
  rules: NewStyleRule[]
  /** Asset URL references found in the rules. */
  assetRefs: AssetRef[]
  /** `@font-face` blocks captured for this file (raw urls). */
  fontFaces?: ParsedFontFace[]
}

/**
 * A stylesheet kept as a file (`mode: 'file'`), pre-flattening. Each part is
 * one source file of the sheet's expanded `@import` graph, in cascade order —
 * kept separate until url() normalisation because relative `url(...)` paths
 * resolve against the PART's own directory, not the top-level sheet's.
 */
export interface RawStylesheetSource {
  /** FileMap key of the top-level linked CSS file. */
  path: string
  /** HTML FileMap sources that linked this stylesheet. */
  pageSources: string[]
  /** Cascade ordering within the user-stylesheet bundle. */
  priority: number
  parts: Array<{ cssPath: string; cssText: string }>
}

interface AssetPlanResult {
  /** pagePlans with URL props in node fragments normalised to FileMap keys. */
  normalizedPagePlans: PagePlan[]
  /** Flat list of all style rules (from all CSS files) with url() values normalised. */
  normalizedStyleRules: NewStyleRule[]
  /** Index-aligned with `normalizedStyleRules`: the source stylesheet path each rule came from. */
  styleRuleSources: string[]
  /** Kept stylesheets, flattened with url() payloads normalised to FileMap keys. */
  stylesheets: ImportStylesheet[]
  /**
   * Custom font families resolved from `@font-face` blocks. Each file's `src`
   * is a FileMap key (rewritten to a media URL later by `applyAssetRewrites`).
   */
  fonts: ImportFontFamily[]
  /** Deduplicated asset list for upload, keyed by FileMap path. */
  assets: { sourcePath: string; mimeType: string; bytes: Uint8Array }[]
  warnings: ImportWarning[]
}

/** Format preference when an `@font-face` lists several fallback files. */
const FONT_FORMAT_RANK: Record<FontFileFormat, number> = {
  woff2: 0,
  woff: 1,
  ttf: 2,
  otf: 3,
}

/** Map a FileMap key's extension to a font format, or null if not a font. */
function fontFormatForPath(path: string): FontFileFormat | null {
  const lower = path.split('?')[0].toLowerCase()
  if (lower.endsWith('.woff2')) return 'woff2'
  if (lower.endsWith('.woff')) return 'woff'
  if (lower.endsWith('.ttf')) return 'ttf'
  if (lower.endsWith('.otf')) return 'otf'
  return null
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Collect and normalise all asset references in the import plan.
 *
 * @param pagePlans      — Raw PagePlans (node fragments have raw HTML URLs).
 * @param cssFileResults — Per-CSS-file parse results including AssetRef lists.
 * @param fileMap        — The FileMap to look up asset bytes.
 */
export function buildAssetPlan(
  pagePlans: PagePlan[],
  cssFileResults: CssFileResult[],
  fileMap: FileMap,
  rawStylesheetSources: RawStylesheetSource[] = [],
): AssetPlanResult {
  const warnings: ImportWarning[] = []
  /** Deduplicated assets by FileMap key. */
  const assetMap = new Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>()

  // --- Normalise node fragments ---
  const normalizedPagePlans: PagePlan[] = pagePlans.map((plan) => {
    const normalizedFragment = normalizeFragment(
      plan.nodeFragment,
      plan.source,
      fileMap,
      assetMap,
    )
    return { ...plan, nodeFragment: normalizedFragment }
  })

  // --- Normalise CSS rules ---
  const normalizedStyleRules: NewStyleRule[] = []
  const styleRuleSources: string[] = []
  for (const { cssPath, rules, assetRefs } of cssFileResults) {
    const normalized = normalizeRules(rules, assetRefs, cssPath, fileMap, assetMap)
    normalizedStyleRules.push(...normalized)
    for (let i = 0; i < normalized.length; i++) styleRuleSources.push(cssPath)
  }

  // --- Flatten + normalise kept stylesheets (mode 'file') ---
  // Each part's url(...) payloads resolve against ITS source file's directory
  // before the parts are joined, so a sub-sheet's `../img/x.png` still finds
  // the right FileMap entry. The per-part comment header keeps the origin
  // visible in the committed SiteFile.
  const stylesheets: ImportStylesheet[] = rawStylesheetSources.map((sheet) => ({
    path: sheet.path,
    pageSources: sheet.pageSources,
    priority: sheet.priority,
    content: sheet.parts
      .map((part) => {
        const normalized = normalizeRawCssUrls(part.cssText, part.cssPath, fileMap, assetMap)
        return sheet.parts.length > 1
          ? `/* ${part.cssPath.replace(/\*\//g, '*\\/')} */\n${normalized}`
          : normalized
      })
      .join('\n\n'),
  }))

  // --- Resolve @font-face blocks into custom font families ---
  const fonts = buildFontFamilies(cssFileResults, fileMap, assetMap, warnings)

  // --- Sweep up unreferenced media/font files ---
  //
  // Anything the user bundled with a CMS-uploadable media/font MIME lands in
  // the media library even when nothing in the imported HTML / CSS refers to
  // it. The intent is "I dragged a folder in, I expect to see those files in
  // my media library" — but source companions (.scss, sourcemaps, PHP mailers,
  // desktop.ini, README files, etc.) are not public site assets and the media
  // endpoint rejects them. Exclude them here so the review counts match the
  // committed import instead of surfacing a wall of upload-time 400s.
  for (const [filePath, entry] of Object.entries(fileMap.files)) {
    if (assetMap.has(filePath)) continue
    const mimeType = entry.mimeType ?? guessMimeType(filePath)
    if (NON_ASSET_MIME_PREFIXES.some((prefix) => mimeType.toLowerCase().startsWith(prefix))) continue
    if (!isImportUploadableMimeType(mimeType)) continue
    assetMap.set(filePath, { sourcePath: filePath, mimeType, bytes: entry.bytes })
  }

  const assets = Array.from(assetMap.values())

  return { normalizedPagePlans, normalizedStyleRules, styleRuleSources, stylesheets, fonts, assets, warnings }
}

/**
 * Normalise every `url(...)` payload in raw CSS text to its FileMap key,
 * registering each referenced asset for upload — the raw-text sibling of
 * `normalizeCssBag` for stylesheets kept as files. External URLs and
 * unresolved paths pass through untouched.
 */
function normalizeRawCssUrls(
  cssText: string,
  basePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): string {
  return cssText.replace(
    /url\(\s*(['"]?)([^'")\n]+)\1\s*\)/g,
    (match, _quote: string, rawUrl: string) => {
      const fileMapKey = resolveAndRecord(rawUrl.trim(), basePath, fileMap, assetMap)
      return fileMapKey ? `url('${fileMapKey}')` : match
    },
  )
}

// ---------------------------------------------------------------------------
// @font-face → custom font families
// ---------------------------------------------------------------------------

/**
 * Resolve every captured `@font-face` into a custom font family.
 *
 * For each face we pick the best self-hostable `src` (preferring woff2 → woff →
 * ttf → otf among the files present in the FileMap) and emit one `ImportFontFile`
 * whose `src` is the FileMap key (rewritten to a media URL downstream). A face
 * whose every src is external / missing yields an `external-font` warning and is
 * skipped. Faces are grouped by family (case-insensitive), so multiple weights
 * of the same family collapse into one entry.
 */
function buildFontFamilies(
  cssFileResults: CssFileResult[],
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
  warnings: ImportWarning[],
): ImportFontFamily[] {
  // family-lowercase → { display family, files, seen (variant) }
  const byFamily = new Map<string, { family: string; files: ImportFontFile[]; seenVariants: Set<string> }>()

  for (const { cssPath, fontFaces } of cssFileResults) {
    if (!fontFaces || fontFaces.length === 0) continue

    for (const face of fontFaces) {
      // Pick the best resolvable src among the face's fallback urls.
      let best: { src: string; format: FontFileFormat } | null = null
      for (const rawUrl of face.srcUrls) {
        const fileMapKey = resolveAndRecord(rawUrl, cssPath, fileMap, assetMap)
        if (!fileMapKey) continue
        const format = fontFormatForPath(fileMapKey)
        if (!format) continue
        if (!best || FONT_FORMAT_RANK[format] < FONT_FORMAT_RANK[best.format]) {
          best = { src: fileMapKey, format }
        }
      }

      if (!best) {
        warnings.push({
          kind: 'external-font',
          message: `@font-face "${face.family}" (${face.variant}) has no bundled font file — skipped. Re-add it via Typography → Upload custom font.`,
          selector: face.family,
        })
        continue
      }

      const key = face.family.toLowerCase()
      let group = byFamily.get(key)
      if (!group) {
        group = { family: face.family, files: [], seenVariants: new Set() }
        byFamily.set(key, group)
      }
      // De-dup identical variants within a family (later wins, like CSS cascade).
      if (group.seenVariants.has(face.variant)) {
        group.files = group.files.filter((f) => f.variant !== face.variant)
      }
      group.seenVariants.add(face.variant)
      group.files.push({
        variant: face.variant,
        format: best.format,
        src: best.src,
        ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
      })
    }
  }

  return Array.from(byFamily.values()).map((g) => ({ family: g.family, files: g.files }))
}

// ---------------------------------------------------------------------------
// Node fragment normalisation
// ---------------------------------------------------------------------------

function normalizeFragment(
  fragment: ImportFragment,
  htmlFilePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): ImportFragment {
  const normalizedNodes: Record<string, PageNode> = {}

  for (const [id, node] of Object.entries(fragment.nodes)) {
    const newProps = normalizeNodeProps(node.props, htmlFilePath, fileMap, assetMap)
    // Inline background images live on `node.inlineStyles` as CSS `url(...)`
    // payloads — normalise them to FileMap keys exactly like CSS-rule
    // background values so `applyAssetRewrites` can swap in the media URL.
    const newInlineStyles = node.inlineStyles
      ? normalizeCssBag(node.inlineStyles as Record<string, string>, htmlFilePath, fileMap, assetMap)
      : undefined
    normalizedNodes[id] = {
      ...node,
      props: newProps,
      ...(newInlineStyles ? { inlineStyles: newInlineStyles } : {}),
    }
  }

  const body = fragment.body
    ? {
        ...fragment.body,
        props: fragment.body.props
          ? normalizeNodeProps(fragment.body.props, htmlFilePath, fileMap, assetMap)
          : undefined,
        inlineStyles: fragment.body.inlineStyles
          ? normalizeCssBag(fragment.body.inlineStyles, htmlFilePath, fileMap, assetMap)
          : undefined,
      }
    : undefined

  return { nodes: normalizedNodes, rootIds: fragment.rootIds, ...(body ? { body } : {}) }
}

/**
 * Normalise every `url(...)` payload inside a CSS property bag to its FileMap
 * key, registering each referenced asset for upload. External / special-scheme
 * URLs and unresolved paths are left untouched.
 */
function normalizeCssBag(
  bag: Record<string, string>,
  basePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): Record<string, string> {
  const out: Record<string, string> = { ...bag }
  for (const [prop, val] of Object.entries(out)) {
    if (typeof val !== 'string') continue
    out[prop] = val.replace(
      /url\(\s*(['"]?)([^'")\n]+)\1\s*\)/g,
      (match, _quote: string, rawUrl: string) => {
        const fileMapKey = resolveAndRecord(rawUrl.trim(), basePath, fileMap, assetMap)
        return fileMapKey ? `url('${fileMapKey}')` : match
      },
    )
  }
  return out
}

function normalizeNodeProps(
  props: Record<string, unknown>,
  htmlFilePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...props }

  for (const propKey of URL_BEARING_PROPS) {
    const val = result[propKey]
    if (typeof val !== 'string' || val.length === 0) continue

    if (propKey === 'srcset') {
      result[propKey] = normalizeSrcset(val, htmlFilePath, fileMap, assetMap)
      continue
    }

    const fileMapKey = resolveAndRecord(val, htmlFilePath, fileMap, assetMap)
    if (fileMapKey !== null) result[propKey] = fileMapKey
    // If null: external URL or not in FileMap — leave original value
  }

  const htmlAttributes = result['htmlAttributes']
  if (isStringRecord(htmlAttributes)) {
    const normalizedAttrs: Record<string, string> = { ...htmlAttributes }
    for (const [attrName, attrValue] of Object.entries(normalizedAttrs)) {
      const fileMapKey = resolveAndRecord(attrValue, htmlFilePath, fileMap, assetMap)
      if (fileMapKey !== null) normalizedAttrs[attrName] = fileMapKey
    }
    result['htmlAttributes'] = normalizedAttrs
  }

  return result
}

/**
 * Normalise a `srcset` attribute value.
 * Format: `url1 2x, url2 1x` or `url1 800w, url2 1200w`.
 * Only the URL parts are replaced; the descriptor (2x, 800w) is preserved.
 */
function normalizeSrcset(
  srcset: string,
  htmlFilePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): string {
  const parts = srcset.split(',').map((s) => s.trim()).filter(Boolean)
  const normalized = parts.map((part) => {
    const [urlPart, ...descriptors] = part.split(/\s+/)
    if (!urlPart) return part
    const fileMapKey = resolveAndRecord(urlPart, htmlFilePath, fileMap, assetMap)
    const url = fileMapKey ?? urlPart
    return descriptors.length > 0 ? `${url} ${descriptors.join(' ')}` : url
  })
  return normalized.join(', ')
}

// ---------------------------------------------------------------------------
// CSS rule normalisation
// ---------------------------------------------------------------------------

function normalizeRules(
  rules: NewStyleRule[],
  assetRefs: AssetRef[],
  cssFilePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): NewStyleRule[] {
  if (assetRefs.length === 0) return rules

  // Group assetRefs by rule index for O(1) lookup
  const refsByRule = new Map<number, AssetRef[]>()
  for (const ref of assetRefs) {
    let bucket = refsByRule.get(ref.ruleIndex)
    if (!bucket) {
      bucket = []
      refsByRule.set(ref.ruleIndex, bucket)
    }
    bucket.push(ref)
  }

  const normalized = rules.map((rule, ruleIdx) => {
    const refs = refsByRule.get(ruleIdx)
    if (!refs || refs.length === 0) return rule

    const newStyles = { ...rule.styles } as Record<string, unknown>
    let newRawCss = rule.rawCss
    // Clone every per-context override bag so url() rewrites don't mutate the
    // source plan. Both viewport contexts and custom conditions live here.
    const newContextStyles: Record<string, Record<string, unknown>> = {}
    for (const [contextId, bag] of Object.entries(rule.contextStyles ?? {})) {
      newContextStyles[contextId] = { ...(bag as Record<string, unknown>) }
    }

    for (const ref of refs) {
      const fileMapKey = resolveAndRecord(ref.rawUrl, cssFilePath, fileMap, assetMap)
      if (fileMapKey === null) continue // external or not in FileMap

      if (ref.rawCss === true) {
        if (typeof newRawCss === 'string') {
          newRawCss = replaceRawUrlInValue(newRawCss, ref.rawUrl, fileMapKey)
        }
      } else if (ref.contextId === undefined) {
        const val = newStyles[ref.property]
        if (typeof val === 'string') {
          newStyles[ref.property] = replaceRawUrlInValue(val, ref.rawUrl, fileMapKey)
        }
      } else {
        const bag = newContextStyles[ref.contextId]
        if (bag) {
          const val = bag[ref.property]
          if (typeof val === 'string') {
            bag[ref.property] = replaceRawUrlInValue(val, ref.rawUrl, fileMapKey)
          }
        }
      }
    }

    return {
      ...rule,
      styles: newStyles,
      contextStyles: newContextStyles,
      ...(newRawCss !== undefined ? { rawCss: newRawCss } : {}),
    }
  })

  // Orphan asset refs — those whose `ruleIndex` doesn't bind to any rule we
  // emitted. The CSS parser uses this for assets that live inside a dropped
  // at-rule we can't model (notably `@font-face`'s `src: url(...)`). We still
  // want the underlying file in `plan.assets` so the user gets the binary in
  // their media library; the @font-face declaration itself is lost, but the
  // file is recoverable.
  for (const [ruleIdx, refs] of refsByRule) {
    if (ruleIdx < normalized.length) continue
    for (const ref of refs) {
      resolveAndRecord(ref.rawUrl, cssFilePath, fileMap, assetMap)
    }
  }

  return normalized
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** URLs that should always pass through unchanged (external + special schemes). */
const EXTERNAL_URL_RE = /^https?:\/\/|^\/\/|^data:|^mailto:|^tel:|^#/

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((entry) => typeof entry === 'string')
}

/**
 * MIME type prefixes that identify web document / script sources.
 *
 * Files with these types are processed by the pipeline as pages or style
 * sources, not uploaded to the media library.  An `<a href="about.html">`
 * anchor should never cause `about.html` to appear in `plan.assets`, even
 * if the file exists in the FileMap.
 */
const NON_ASSET_MIME_PREFIXES: readonly string[] = [
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
]

/**
 * Resolve a raw URL relative to `basePath`, look it up in the FileMap,
 * register the asset in `assetMap`, and return the FileMap key.
 *
 * Returns null when:
 *   - the URL is external / uses a special scheme,
 *   - the resolved path is not in the FileMap, or
 *   - the resolved file is a web document / script (HTML, CSS, JS), or any
 *     other MIME the CMS media endpoint cannot store.
 */
function resolveAndRecord(
  rawUrl: string,
  basePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): string | null {
  if (!rawUrl || EXTERNAL_URL_RE.test(rawUrl)) return null

  const fileMapKey = resolveRelativePath(rawUrl, basePath)
  if (!fileMapKey) return null

  const entry = fileMap.files[fileMapKey]
  if (!entry) return null

  const mimeType = entry.mimeType ?? guessMimeType(fileMapKey)

  // HTML, CSS, and JS files are page/style sources — never upload them as
  // media assets.  An anchor <a href="other-page.html"> must not cause
  // "other-page.html" to appear in plan.assets. Likewise, source companions
  // such as SCSS, sourcemaps, PHP mail handlers, and OS metadata are not
  // public media assets and would be rejected by the media endpoint.
  if (NON_ASSET_MIME_PREFIXES.some((prefix) => mimeType.toLowerCase().startsWith(prefix))) {
    return null
  }
  if (!isImportUploadableMimeType(mimeType)) return null

  if (!assetMap.has(fileMapKey)) {
    assetMap.set(fileMapKey, { sourcePath: fileMapKey, mimeType, bytes: entry.bytes })
  }

  return fileMapKey
}

/**
 * Resolve a raw URL against a base file path to produce a FileMap key.
 * Returns null for traversal-escaping paths or empty strings.
 */
function resolveRelativePath(rawUrl: string, basePath: string): string | null {
  const baseDir = dirname(basePath)

  const resolved = rawUrl.startsWith('/')
    ? rawUrl.slice(1) // root-relative: strip leading /
    : joinPaths(baseDir, rawUrl)

  // Reject escaped or empty results
  if (!resolved || resolved.startsWith('../')) return null

  return resolved
}

/** Replace a raw URL payload inside a CSS `url()` expression with the FileMap key. */
function replaceRawUrlInValue(value: string, rawUrl: string, fileMapKey: string): string {
  // Escape the rawUrl for use in a regex
  const escaped = rawUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match url(), url(''), url("") variants
  const re = new RegExp(`url\\(\\s*(['"]?)${escaped}\\1\\s*\\)`, 'g')
  return value.replace(re, `url('${fileMapKey}')`)
}

