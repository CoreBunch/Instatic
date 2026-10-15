/**
 * Shared anchor-`target` vocabulary for the base modules that emit `<a>`
 * elements (`base.link` and `base.button`).
 *
 * Both modules used to redeclare an identical `Type.Union([_self, _blank,
 * _parent])` schema, an identical select-options array, AND an identical
 * `rel="noopener noreferrer"` rule — once in the publisher `render()` path and
 * again in the canvas `*Editor.tsx`. Four copies of the rel logic meant four
 * places for the canvas and the published page to drift apart. They now share
 * this one leaf:
 *
 *   - `AnchorTargetSchema` / `AnchorTarget`  — the persisted prop shape.
 *   - `ANCHOR_TARGET_OPTIONS`                — the Properties-panel select.
 *   - `anchorRel(target)`                    — the single rel decision.
 *   - `mergeAnchorRel(authored, target)`     — that decision merged with the
 *                                              author's own `rel` tokens.
 *   - `anchorHtmlAttributes(bag, target)`    — the `htmlAttributes` bag with
 *                                              `rel` pulled out and merged.
 *
 * Lives in a non-component `.ts` so the editor components can import it without
 * breaking React Fast Refresh (Constraint #309).
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { normalizeHtmlAttributes } from '@core/htmlAttributes'

export const AnchorTargetSchema = Type.Union(
  [Type.Literal('_self'), Type.Literal('_blank'), Type.Literal('_parent')],
  { default: '_self' },
)

type AnchorTarget = Static<typeof AnchorTargetSchema>

/** Select options for the Properties-panel `target` control. */
export const ANCHOR_TARGET_OPTIONS: ReadonlyArray<{ label: string; value: AnchorTarget }> = [
  { label: 'Same tab', value: '_self' },
  { label: 'New tab', value: '_blank' },
  { label: 'Parent', value: '_parent' },
]

/**
 * The canonical `rel` value for an anchor with the given `target`. Opening a
 * link in a new tab (`_blank`) without `rel="noopener noreferrer"` leaks the
 * opener window to the destination (reverse-tabnabbing), so new-tab links —
 * and only those — get the hardened rel. Returns `null` when no rel is needed
 * so each call site serializes it the way its output demands (attribute string
 * vs. JSX `rel` prop).
 */
export function anchorRel(target: AnchorTarget): string | null {
  return target === '_blank' ? 'noopener noreferrer' : null
}

/**
 * The single `rel` an anchor emits when the author also wrote one. Authors put
 * `rel` in the `htmlAttributes` bag (the Properties-panel Attributes view, or
 * an imported `<a rel="nofollow">`), and the module adds the security rel for
 * its `target`. Emitting both as separate attributes is a duplicate-attribute
 * parse error: the browser keeps the first one, so `rel="nofollow"` placed
 * before the module's `rel="noopener noreferrer"` silently loses the
 * reverse-tabnabbing guard on a new-tab link. This merges the two into one
 * space-separated token list — the author's tokens first, then whatever
 * `anchorRel(target)` requires, each token once — or `null` when there is
 * nothing to emit. A `_blank` anchor therefore always carries
 * `noopener noreferrer`, whatever the author wrote.
 */
export function mergeAnchorRel(authoredRel: unknown, target: AnchorTarget): string | null {
  const tokens = new Set<string>()
  if (typeof authoredRel === 'string') {
    for (const token of authoredRel.split(/\s+/)) if (token) tokens.add(token)
  }
  for (const token of anchorRel(target)?.split(' ') ?? []) tokens.add(token)
  return tokens.size > 0 ? [...tokens].join(' ') : null
}

/**
 * Split an anchor's `htmlAttributes` bag into the attributes to spread as-is
 * and the one merged `rel` (see `mergeAnchorRel`). Both the publisher
 * `render()` and the canvas editor of `base.link` / `base.button` go through
 * this so neither path can emit `rel` twice.
 */
export function anchorHtmlAttributes(
  htmlAttributes: unknown,
  target: AnchorTarget,
): { attributes: Record<string, string>; rel: string | null } {
  const { rel: authoredRel, ...attributes } = normalizeHtmlAttributes(htmlAttributes)
  return { attributes, rel: mergeAnchorRel(authoredRel, target) }
}
