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
 *
 * Lives in a non-component `.ts` so the editor components can import it without
 * breaking React Fast Refresh (Constraint #309).
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

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
