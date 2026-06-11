/**
 * Resolving which canvas element belongs to a read-only composed region
 * (template chrome, an inlined Visual Component, an outlet preview) vs. the
 * active document's own editable content.
 *
 * Read-only composed nodes carry `data-instatic-readonly-*` markers; the active
 * document's editable nodes carry `data-node-id`. The two are mutually
 * exclusive on a single element (see `ReadOnlyNodeTree`).
 *
 * The subtlety: the active document's content is spliced into the wrapping
 * template's `base.outlet`, so editable nodes live *inside* the read-only
 * wrapper element in the DOM. Walking straight up to the nearest
 * `[data-instatic-readonly-*]` ancestor therefore mislabels editable content as
 * read-only — which made the hover hint fire over the whole page and the
 * double-click-to-open hijack inline editing on any templated page. The fix is
 * to resolve the NEAREST boundary of *either* kind: an editable node nearer
 * than any read-only marker means the target is editable.
 */

/** Cross-realm-safe Element check — the iframe is a different realm, so
 * `instanceof Element` is false for nodes inside it. Duck-type `closest`. */
export function isElementLike(value: EventTarget | null): value is Element {
  return value != null && typeof (value as { closest?: unknown }).closest === 'function'
}

/**
 * The nearest read-only region element for a target, or `null` when the target
 * is the active document's editable content (or outside any region). Callers
 * read `data-instatic-readonly-label` / `-kind` / `-id` off the returned element.
 */
export function closestReadonlyRegion(target: EventTarget | null): Element | null {
  if (!isElementLike(target)) return null
  const boundary = target.closest('[data-node-id], [data-instatic-readonly-label]')
  // An editable node (data-node-id) nearer than any read-only marker means the
  // target is editable content spliced into a template outlet — not read-only.
  if (!boundary || boundary.hasAttribute('data-node-id')) return null
  return boundary
}
