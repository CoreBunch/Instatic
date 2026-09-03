/**
 * Identity tint per branch. Main stays achromatic; every other branch gets a
 * deterministic accent from the shared pill palette, exposed as the
 * `--branch-accent` custom property the switcher stylesheet reads. Color is
 * identity here, never decoration — it lands on the icon and the name only.
 */
import type { CSSProperties } from 'react'
import { MAIN_BRANCH_ID, type SiteBranch } from '@core/branches'
import { pillAccent, pillAccentVar } from '@ui/pillAccent'

export function branchAccentStyle(branch: Pick<SiteBranch, 'id'>): CSSProperties | undefined {
  if (branch.id === MAIN_BRANCH_ID) return undefined
  return { '--branch-accent': pillAccentVar(pillAccent(branch.id)) } as CSSProperties
}
