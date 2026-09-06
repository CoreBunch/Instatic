/**
 * The sentence a destructive confirmation shows when part of a selection is
 * still depended on.
 *
 * Three rules, from watching a real deletion go wrong:
 *
 *   SEPARATE. "1 of 11" lets the operator see the other ten are safe. A
 *   blanket "some of these are in use" is the kind of warning people learn to
 *   click past, because it never tells them which.
 *
 *   NAME IT. "your profile picture", not "has a reference". The point is that
 *   they recognise what they are about to lose.
 *
 *   DO NOT BLOCK. Deleting an in-use asset is a legitimate thing to want —
 *   replacing an avatar starts exactly that way. The confirmation informs;
 *   the operator still decides.
 */

import type { CmsMediaUsageRef } from '@core/persistence/cmsMedia'

/** Beyond this many named items the list becomes a wall rather than a warning. */
const MAX_NAMED = 3

export interface UsageWarning {
  /** e.g. `1 of 11 is still in use:` */
  heading: string
  /** One line per named dependency, already resolved for display. */
  lines: string[]
}

function describe(ref: CmsMediaUsageRef): string {
  switch (ref.refKind) {
    case 'user.avatar':
      return `profile picture — ${ref.label}`
    default:
      return ref.label
  }
}

/**
 * `null` when nothing in the selection is depended on — the caller shows its
 * ordinary confirmation and says nothing extra.
 */
export function buildUsageWarning(
  selectionSize: number,
  refs: readonly CmsMediaUsageRef[],
): UsageWarning | null {
  if (refs.length === 0) return null

  // One row per asset: an asset used twice is still one file to lose.
  const byAsset = new Map<string, CmsMediaUsageRef>()
  for (const ref of refs) if (!byAsset.has(ref.assetId)) byAsset.set(ref.assetId, ref)
  const used = [...byAsset.values()]

  const heading = selectionSize > used.length
    ? `${used.length} of ${selectionSize} ${used.length === 1 ? 'is' : 'are'} still in use:`
    : `${used.length === 1 ? 'This file is' : 'These files are'} still in use:`

  const named = used.slice(0, MAX_NAMED).map(describe)
  const rest = used.length - named.length
  if (rest > 0) named.push(`and ${rest} more`)

  return { heading, lines: named }
}

/**
 * Ask what depends on these assets, then phrase it.
 *
 * NEVER REJECTS. This is the single door all three confirmations go through,
 * so the guarantee belongs here rather than in each `lookupUsage` — the
 * warning is advisory, and a failed request has to degrade to the plain
 * confirmation. If this could reject, the `void (async () => …)()` that opens
 * each dialog would drop the rejection on the floor and the dialog would
 * never appear: a delete button that silently does nothing, which is worse
 * than one that deletes without the extra warning.
 *
 * Deliberately NOT a hook holding state: every caller awaits this immediately
 * before opening its confirmation, and a `setState` would not be visible in
 * the closure that opens the dialog — the warning would always be one delete
 * behind. Callers that need it across renders (a dialog kept open) store the
 * returned value themselves.
 *
 * `selectionSize` is what the operator is being asked about, which is not
 * always `assetIds.length`: the bulk window purges only the trashed members of
 * a mixed selection, so "1 of 3" has to count the three it will delete.
 */
export async function resolveUsageWarning(
  lookupUsage: (assetIds: string[]) => Promise<CmsMediaUsageRef[]>,
  assetIds: string[],
  selectionSize: number = assetIds.length,
): Promise<UsageWarning | null> {
  if (assetIds.length === 0) return null
  try {
    return buildUsageWarning(selectionSize, await lookupUsage(assetIds))
  } catch (err) {
    console.error('[usageWarning] usage lookup failed:', err)
    return null
  }
}
