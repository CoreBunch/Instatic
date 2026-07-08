/**
 * Publisher — root-element class attribute injection.
 *
 * Page-author classIds need to land on the ROOT element of whatever HTML a
 * node produced — never on a nested descendant. Two cases:
 *
 *   1. Root tag already has `class="..."` → prepend the new classes.
 *      `<div class="existing">` → `<div class="class_name existing">`
 *   2. Root tag has no class attribute → insert one as the first attribute.
 *      `<button type="button">` → `<button class="class_name" type="button">`
 *
 * Shared by the standard renderer, `renderVisualComponentRef`, and
 * `renderLoop` — the three call sites that emit a wrapper element on which
 * page-author classes must land. Keeping the logic in one helper means a
 * new render path that needs author-class support is one call, not five
 * duplicated lines.
 */

import type { SiteDocument } from '@core/page-tree'
import { classNamesForClassIds } from '@core/page-tree'
import { bagToInlineStyle } from './classCss'
import { escapeHtml } from './utils'
import type { RenderResolvedMedia } from './renderConfig'

/**
 * Inject a class attribute into the ROOT element of an HTML string.
 *
 * The function locates the first opening element tag in `html` and modifies
 * only that tag — never a nested descendant.
 *
 * The classAttr string is pre-validated by the caller (class tokens, HTML-escaped).
 *
 * Comments / DOCTYPE / processing-instructions before the first element tag
 * are skipped — they don't take a class attribute. If `html` contains no
 * element tag at all (e.g. a comment-only placeholder, or empty string),
 * the original `html` is returned unchanged.
 *
 * Anchoring on the FIRST tag is essential: the previous implementation used
 * a non-anchored regex that could match a nested descendant's `class="..."`
 * when the root had no class — causing parent classes to be wrongly prepended
 * to the deepest classed element rather than to the root itself.
 */
function injectClassIntoRootElement(html: string, classAttr: string): string {
  // Find the first opening element tag. Anchored on `<[a-zA-Z]` so it skips
  // `<!--`, `<!DOCTYPE`, and `<?xml`-style prefixes.
  // `[^>]*` is safe because module render() output escapes attribute values
  // (so `>` cannot appear inside an attribute value here).
  const tagMatch = html.match(/<([a-zA-Z][\w-]*)\b([^>]*)>/)
  if (!tagMatch) return html

  const [fullMatch, tagName, attrs] = tagMatch
  const tagStart = tagMatch.index ?? 0

  // Does the ROOT tag already carry a class attribute?
  const classRe = /\bclass="([^"]*)"/
  const existingClass = attrs.match(classRe)

  let newAttrs: string
  if (existingClass) {
    // Prepend the new classes to the existing list (preserve cascade order)
    newAttrs = attrs.replace(classRe, `class="${classAttr} ${existingClass[1]}"`)
  } else {
    // Insert the class as the first attribute on the root tag
    newAttrs = ` class="${classAttr}"${attrs}`
  }

  const newTag = `<${tagName}${newAttrs}>`
  return html.slice(0, tagStart) + newTag + html.slice(tagStart + fullMatch.length)
}

/**
 * Inject a node's user-applied classIds onto its rendered root element.
 *
 * Resolves classIds against `site.styleRules` (skipping unknown ids), HTML-escapes
 * every token, joins them with spaces, and prepends the result onto the root
 * element's `class` attribute (or inserts a new attribute when there isn't
 * one). Returns the original `html` unchanged when the node has no classIds,
 * when every classId is unknown, or when `html` contains no element tag.
 */
export function injectNodeClassIds(
  html: string,
  classIds: readonly string[] | undefined,
  site: SiteDocument,
): string {
  if (!classIds?.length) return html
  const classAttr = classNamesForClassIds(site.styleRules, classIds)
    .map(escapeHtml)
    .join(' ')
  if (!classAttr) return html
  return injectClassIntoRootElement(html, classAttr)
}

/**
 * Inject (or merge into) a `style="…"` attribute on the ROOT element of an HTML
 * string. Author inline styles are appended AFTER any style the module already
 * emitted so the author's declarations win (last declaration wins within an
 * inline style attribute).
 *
 * `styleAttr` is the already-built declaration string (`prop: value; …`); this
 * function HTML-escapes it for the attribute context.
 */
function injectStyleIntoRootElement(html: string, styleAttr: string): string {
  const tagMatch = html.match(/<([a-zA-Z][\w-]*)\b([^>]*)>/)
  if (!tagMatch) return html

  const [fullMatch, tagName, attrs] = tagMatch
  const tagStart = tagMatch.index ?? 0
  const escaped = escapeHtml(styleAttr)

  const styleRe = /\bstyle="([^"]*)"/
  const existingStyle = attrs.match(styleRe)

  let newAttrs: string
  if (existingStyle) {
    // Append author declarations after the module's own so the author wins.
    const merged = `${existingStyle[1].replace(/;\s*$/, '')}; ${escaped}`
    newAttrs = attrs.replace(styleRe, `style="${merged}"`)
  } else {
    newAttrs = ` style="${escaped}"${attrs}`
  }

  const newTag = `<${tagName}${newAttrs}>`
  return html.slice(0, tagStart) + newTag + html.slice(tagStart + fullMatch.length)
}

/**
 * Inject a node's inline styles onto its rendered root element as a `style="…"`
 * attribute. Serialises the bag via `bagToInlineStyle` (same emittable-property
 * / sanitisation rules as published class CSS). Returns `html` unchanged when
 * the node has no inline styles, when nothing survives sanitisation, or when
 * `html` has no element tag.
 */
export function injectNodeInlineStyles(
  html: string,
  inlineStyles: Record<string, unknown> | undefined,
  mediaAssets?: ReadonlyMap<string, RenderResolvedMedia>,
): string {
  if (!inlineStyles || Object.keys(inlineStyles).length === 0) return html
  const styleAttr = bagToInlineStyle(inlineStyles, { mediaAssets })
  if (!styleAttr) return html
  return injectStyleIntoRootElement(html, styleAttr)
}

/**
 * Inject a `uid="<id>"` attribute onto the ROOT element of an HTML
 * string. Editor-only annotation used by the agent read-surface (and the token
 * benchmark) so each tag can be traced back to the page node that produced it.
 *
 * Inserted as the first attribute on the first opening element tag — never on a
 * nested descendant. Returns `html` unchanged when there is no element tag to
 * annotate (e.g. an unknown-module comment, or a module that emits no wrapper):
 * the caller treats that as an "unannotatable node".
 */
export function injectNodeId(html: string, nodeId: string): string {
  const tagMatch = html.match(/<([a-zA-Z][\w-]*)\b([^>]*)>/)
  if (!tagMatch) return html

  const [fullMatch, tagName, attrs] = tagMatch
  const tagStart = tagMatch.index ?? 0
  const newTag = `<${tagName} uid="${escapeHtml(nodeId)}"${attrs}>`
  return html.slice(0, tagStart) + newTag + html.slice(tagStart + fullMatch.length)
}
