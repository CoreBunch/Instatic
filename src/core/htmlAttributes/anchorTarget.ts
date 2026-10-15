/**
 * The anchor-`target` vocabulary the base modules persist (`base.link` and
 * `base.button`), and the one place that maps authored HTML onto it.
 *
 * Lives core-side because both the block catalogue (the schema each module
 * embeds) and the engine (the HTML importer) need it, and `src/core/` never
 * imports `src/modules/`. The module-specific pieces — the Properties-panel
 * select options and the `rel` decision — stay in
 * `@modules/base/shared/anchorTarget`.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const AnchorTargetSchema = Type.Union(
  [Type.Literal('_self'), Type.Literal('_blank'), Type.Literal('_parent')],
  { default: '_self' },
)

export type AnchorTarget = Static<typeof AnchorTargetSchema>

const ANCHOR_TARGETS: ReadonlySet<string> = new Set(
  AnchorTargetSchema.anyOf.map((literal) => literal.const),
)

/**
 * Map a raw HTML `target` attribute onto the persisted vocabulary.
 *
 * Authored markup carries values the schema does not model, and none of them
 * can be stored as-is: `AnchorTargetSchema` would reject the node's props at
 * publish time. Each maps to the stored value that navigates the same way
 * outside a frameset. An empty string (`target=""` or a bare `target`) and
 * `_top` open in the same tab, so they become `_self`. Any other value names
 * a browsing context; with no frame of that name the browser opens a new tab,
 * so it becomes `_blank`. HTML matches the keywords ASCII case-insensitively,
 * so `_BLANK` is still `_blank`.
 */
export function normalizeAnchorTarget(raw: string | null | undefined): AnchorTarget {
  if (raw === null || raw === undefined) return '_self'
  const keyword = raw.toLowerCase()
  if (ANCHOR_TARGETS.has(keyword)) return keyword as AnchorTarget
  return keyword === '' || keyword === '_top' ? '_self' : '_blank'
}
