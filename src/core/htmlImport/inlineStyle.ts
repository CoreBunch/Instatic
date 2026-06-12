/**
 * Harvest inline `style="…"` declarations into a per-node CSS bag.
 *
 * The editor models a first-class per-node inline-style layer (`node.inlineStyles`,
 * a camelCase CSS property bag the publisher emits as `style="…"`). The importer
 * preserves an element's inline `style` attribute straight onto that layer so a
 * pasted / agent-authored / imported element keeps the exact look it was given,
 * editable afterwards in the canvas like any other inline style.
 *
 * Every declaration is preserved EXCEPT names rejected by `isEmittableProperty`
 * (the publisher's security denylist — the same gate `cssToStyleRules` uses for
 * imported stylesheets). Background `url(...)` images are canonicalised to the
 * `url('payload')` form so the Super Import asset rewriter and the editor's
 * media picker both recognise them.
 *
 * The harvest runs BEFORE `stripUnsafe` removes the `style` attribute, keyed by
 * the live `Element` so `walkAndMap` can attach the captured bag to the PageNode
 * it mints for that element.
 */

import {
  encodeSubstitutionDeclarationList,
  readCssDeclarationBag,
  SUBSTITUTION_FN_RE,
} from '@core/css-substitution'

/** Match the first `url(...)` payload in a CSS value (quoted or bare). */
const URL_PAYLOAD_RE = /url\(\s*(['"]?)([^'")\n]+)\1\s*\)/i

/**
 * Canonicalise a background `url(...)` image onto `out.backgroundImage` in the
 * `url('payload')` form, whether it arrived as the `background-image` longhand
 * or inside a `background:` shorthand the environment didn't expand. No-op when
 * the element has no url() background (colours / gradients stay as captured).
 */
function normalizeBackgroundImage(style: CSSStyleDeclaration, out: Record<string, string>): void {
  let raw = typeof out.backgroundImage === 'string' ? out.backgroundImage.trim() : ''
  if (!raw || raw.toLowerCase() === 'none') {
    raw = (typeof out.background === 'string' ? out.background : style.getPropertyValue('background')).trim()
  }
  const m = raw.match(URL_PAYLOAD_RE)
  if (m) out.backgroundImage = `url('${m[2].trim()}')`
}

/**
 * Pull every inline declaration out of one element's parsed `style` attribute
 * into a camelCase CSS bag, dropping only the security-denied property names.
 * Returns `{}` when the element has no usable inline declarations.
 */
function extractInlineStyles(style: CSSStyleDeclaration): Record<string, string> {
  const out = readCssDeclarationBag(style)
  normalizeBackgroundImage(style, out)
  return out
}

/**
 * Walk every element in `doc` and harvest its inline `style` declarations into a
 * `Map` keyed by the element. Call this BEFORE `stripUnsafe` (which removes the
 * `style` attribute). Elements with no usable inline declarations are absent.
 */
export function harvestInlineStyles(doc: Document): Map<Element, Record<string, string>> {
  const result = new Map<Element, Record<string, string>>()
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    // `el.style` is the parsed inline-style declaration. Reading it avoids a
    // hand-rolled CSS parser and matches the engine the publisher trusts.
    const styledEl = el as Element & { style?: CSSStyleDeclaration }
    if (!styledEl.style || !el.hasAttribute('style')) continue
    // Declarations whose value uses `var()`/`env()` are lossy/engine-divergent
    // through CSSStyleDeclaration (see @core/css-substitution). The authored
    // attribute text is still at hand here — re-set it with those declarations
    // encoded as marker custom properties, which every engine preserves
    // verbatim; `extractInlineStyles` decodes them back. The document is the
    // importer's own parse artifact and `stripUnsafe` removes the attribute
    // afterwards, so mutating it is safe.
    const authored = el.getAttribute('style') ?? ''
    if (SUBSTITUTION_FN_RE.test(authored)) {
      el.setAttribute('style', encodeSubstitutionDeclarationList(authored))
    }
    const bag = extractInlineStyles(styledEl.style)
    if (Object.keys(bag).length > 0) result.set(el, bag)
  }
  return result
}
