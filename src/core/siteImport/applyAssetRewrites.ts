/**
 * applyAssetRewrites — pure, idempotent URL rewrite over an ImportPlan.
 *
 * Given a rewrite map `sourcePath → newUrl` (where `sourcePath` is a FileMap
 * key that the asset normalisation step in `assetPlan.ts` already substituted
 * into all node props and CSS rule values), replace every occurrence with the
 * newly-uploaded `newUrl`.
 *
 * Two surfaces to rewrite:
 *   1. Page node props — string values for `src`, `href`, `srcset` that equal
 *      a FileMap key after normalisation by `assetPlan`, plus imported
 *      `htmlAttributes` bags such as `data-bg-src`.
 *   2. CSS rule `styles` and `contextStyles` — `url('key')` expressions where
 *      the URL payload is a normalised FileMap key.
 *
 * Idempotency: calling twice with the same map is safe — subsequent calls
 * simply look for the newUrl pattern in the plan and find no FileMap-key
 * matches, leaving everything unchanged.
 */

import type { PageNode } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'
import type { ImportPlan, ImportStylesheet, NewStyleRule, ImportFontFamily } from './types'

// ---------------------------------------------------------------------------
// Props that may carry normalised FileMap keys in page nodes
// ---------------------------------------------------------------------------

const URL_BEARING_PROPS: ReadonlySet<string> = new Set(['src', 'href', 'srcset'])

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Rewrite all normalised FileMap-key URLs in `plan` to their final `newUrl`
 * values.  Returns a new `ImportPlan` — the original is not mutated.
 *
 * @param plan       — ImportPlan produced by `buildImportPlan`.
 * @param rewriteMap — Maps `sourcePath` (FileMap key) → uploaded media URL.
 */
export function applyAssetRewrites(
  plan: ImportPlan,
  rewriteMap: Record<string, string>,
): ImportPlan {
  if (Object.keys(rewriteMap).length === 0) return plan

  return {
    ...plan,
    pages: plan.pages.map((p) => ({
      ...p,
      nodeFragment: rewriteFragment(p.nodeFragment, rewriteMap),
    })),
    styleRules: plan.styleRules.map((r) => rewriteRule(r, rewriteMap)),
    fonts: (plan.fonts ?? []).map((f) => rewriteFontFamily(f, rewriteMap)),
    stylesheets: (plan.stylesheets ?? []).map((s) => rewriteStylesheet(s, rewriteMap)),
  }
}

/**
 * Rewrite `url('key')` payloads inside a kept stylesheet's flattened CSS text
 * — the keys were normalised by `buildAssetPlan.normalizeRawCssUrls`.
 */
function rewriteStylesheet(
  sheet: ImportStylesheet,
  rewriteMap: Record<string, string>,
): ImportStylesheet {
  const content = rewriteUrlsInCssValue(sheet.content, rewriteMap)
  return content === sheet.content ? sheet : { ...sheet, content }
}

/**
 * Rewrite each font file's `src` (a FileMap key) to its uploaded media URL.
 * A file whose `src` didn't upload keeps its FileMap key — `commitImportPlan`
 * drops files that still hold a non-URL src so a failed upload never produces a
 * broken `@font-face`.
 */
function rewriteFontFamily(
  font: ImportFontFamily,
  rewriteMap: Record<string, string>,
): ImportFontFamily {
  return {
    ...font,
    files: font.files.map((file) => {
      const url = rewriteMap[file.src]
      return url ? { ...file, src: url } : file
    }),
  }
}

// ---------------------------------------------------------------------------
// Fragment rewriting
// ---------------------------------------------------------------------------

function rewriteFragment(
  fragment: ImportFragment,
  rewriteMap: Record<string, string>,
): ImportFragment {
  const rewrittenNodes: Record<string, PageNode> = {}

  for (const [id, node] of Object.entries(fragment.nodes)) {
    const newProps = rewriteProps(node.props, rewriteMap)
    // Inline background `url('key')` values on `node.inlineStyles` rewrite to
    // their uploaded media URL just like CSS-rule background values.
    const newInlineStyles = node.inlineStyles
      ? rewriteStylesBag(node.inlineStyles, rewriteMap)
      : undefined
    rewrittenNodes[id] = {
      ...node,
      props: newProps,
      ...(newInlineStyles ? { inlineStyles: newInlineStyles } : {}),
    }
  }

  const body = fragment.body
    ? {
        ...fragment.body,
        props: fragment.body.props ? rewriteProps(fragment.body.props, rewriteMap) : undefined,
        inlineStyles: fragment.body.inlineStyles
          ? rewriteStringStylesBag(fragment.body.inlineStyles, rewriteMap)
          : undefined,
      }
    : undefined

  return { nodes: rewrittenNodes, rootIds: fragment.rootIds, ...(body ? { body } : {}) }
}

function rewriteProps(
  props: Record<string, unknown>,
  rewriteMap: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...props }

  for (const propKey of URL_BEARING_PROPS) {
    const val = result[propKey]
    if (typeof val !== 'string' || val.length === 0) continue

    if (propKey === 'srcset') {
      result[propKey] = rewriteSrcset(val, rewriteMap)
      continue
    }

    // Exact match: the normalised prop value equals a FileMap key
    const newUrl = rewriteMap[val]
    if (newUrl) result[propKey] = newUrl
  }

  const htmlAttributes = result['htmlAttributes']
  if (isStringRecord(htmlAttributes)) {
    const rewrittenAttrs: Record<string, string> = { ...htmlAttributes }
    for (const [attrName, attrValue] of Object.entries(rewrittenAttrs)) {
      rewrittenAttrs[attrName] = rewriteMap[attrValue] ?? attrValue
    }
    result['htmlAttributes'] = rewrittenAttrs
  }

  return result
}

/**
 * Rewrite URL tokens within a `srcset` value.
 * Format: `"url1 2x, url2 1x"` — each token is the URL, descriptor preserved.
 */
function rewriteSrcset(srcset: string, rewriteMap: Record<string, string>): string {
  const parts = srcset.split(',').map((s) => s.trim()).filter(Boolean)
  const rewritten = parts.map((part) => {
    const [urlPart, ...descriptors] = part.split(/\s+/)
    if (!urlPart) return part
    const newUrl = rewriteMap[urlPart] ?? urlPart
    return descriptors.length > 0 ? `${newUrl} ${descriptors.join(' ')}` : newUrl
  })
  return rewritten.join(', ')
}

// ---------------------------------------------------------------------------
// Style rule rewriting
// ---------------------------------------------------------------------------

function rewriteRule(rule: NewStyleRule, rewriteMap: Record<string, string>): NewStyleRule {
  const newStyles = rewriteStylesBag(
    rule.styles as Record<string, unknown>,
    rewriteMap,
  )
  const newRawCss = typeof rule.rawCss === 'string'
    ? rewriteUrlsInCssValue(rule.rawCss, rewriteMap)
    : rule.rawCss

  // Every per-context override (viewport contexts AND custom conditions) lives
  // in one map now and can carry url() backgrounds — rewrite each bag to the
  // uploaded media URLs just like base styles.
  const newContextStyles: Record<string, Record<string, unknown>> = {}
  for (const [contextId, bag] of Object.entries(rule.contextStyles ?? {})) {
    newContextStyles[contextId] = rewriteStylesBag(
      bag as Record<string, unknown>,
      rewriteMap,
    )
  }

  return {
    ...rule,
    styles: newStyles,
    contextStyles: newContextStyles,
    ...(newRawCss !== undefined ? { rawCss: newRawCss } : {}),
  }
}

/**
 * Walk a CSS property bag and replace `url('key')` expressions whose URL
 * payload matches a key in `rewriteMap`.
 */
function rewriteStylesBag(
  bag: Record<string, unknown>,
  rewriteMap: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...bag }

  for (const [prop, val] of Object.entries(result)) {
    if (typeof val !== 'string') continue
    const rewritten = rewriteUrlsInCssValue(val, rewriteMap)
    if (rewritten !== val) result[prop] = rewritten
  }

  return result
}

function rewriteStringStylesBag(
  bag: Record<string, string>,
  rewriteMap: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = { ...bag }

  for (const [prop, val] of Object.entries(result)) {
    const rewritten = rewriteUrlsInCssValue(val, rewriteMap)
    if (rewritten !== val) result[prop] = rewritten
  }

  return result
}

/**
 * Replace all `url('key')` / `url("key")` occurrences in a CSS value string
 * whose URL payload (the key) appears in `rewriteMap`.
 */
function rewriteUrlsInCssValue(
  value: string,
  rewriteMap: Record<string, string>,
): string {
  return value.replace(
    /url\(\s*(['"]?)([^'")\n]+)\1\s*\)/g,
    (match, _quote, urlPayload) => {
      const newUrl = rewriteMap[urlPayload.trim()]
      return newUrl ? `url('${newUrl}')` : match
    },
  )
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((entry) => typeof entry === 'string')
}
