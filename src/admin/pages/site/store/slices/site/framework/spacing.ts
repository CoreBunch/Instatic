/**
 * Framework spacing — store actions.
 *
 * The action implementations live in `./scaleGroups.ts` (shared with the
 * typography family). This file is the thin family-specific wrapper: it
 * binds the generic actions to family-specific names and types so the
 * SiteSlice's external API stays explicit (`createFrameworkSpacingGroup`,
 * not `createGroup`).
 */

import type { SiteDocument } from '@core/page-tree'
import type { FrameworkSpacingGroup } from '@core/framework-schema'
import {
  buildDefaultSpacingGroup,
  makeFreshSpacingGroup,
  nextSpacingTabValues,
} from '@core/framework'
import { createScaleGroupActions } from './scaleGroups'
import type { SiteSlice, SiteSliceHelpers } from '@site/store/slices/site/types'

/**
 * Mirror the field-level effect of `applyFrameworkSpacingGroupPatch`
 * (in siteSlice) on a draft site for the *preview* path. Only fields
 * that influence which utility classes get generated need to be
 * applied — fields like display name don't affect class IDs or class
 * names so they're intentionally skipped.
 */
export function applySpacingGroupPatchPreview(
  draft: SiteDocument,
  groupId: string,
  patch: Record<string, unknown>,
): void {
  const sg = draft.settings.framework?.spacing
  if (!sg) return
  const group = sg.groups.find((g) => g.id === groupId)
  if (!group) return
  if (typeof patch.namingConvention === 'string') {
    group.namingConvention = patch.namingConvention
  }
  if (typeof patch.steps === 'string') group.steps = patch.steps
  if (typeof patch.mode === 'string') {
    group.mode = patch.mode as FrameworkSpacingGroup['mode']
  }
  if (typeof patch.isDisabled === 'boolean') group.isDisabled = patch.isDisabled
  if (Array.isArray(patch.manualSizes)) {
    group.manualSizes = patch.manualSizes as FrameworkSpacingGroup['manualSizes']
  }
}

type FrameworkSpacingActions = Pick<
  SiteSlice,
  | 'toggleFrameworkSpacingDisabled'
  | 'createFrameworkSpacingGroup'
  | 'updateFrameworkSpacingGroup'
  | 'duplicateFrameworkSpacingGroup'
  | 'resetFrameworkSpacingGroup'
  | 'deleteFrameworkSpacingGroup'
  | 'upsertFrameworkSpacingManualSize'
  | 'setFrameworkSpacingClassGenerators'
>

export function createFrameworkSpacingActions(
  helpers: SiteSliceHelpers,
): FrameworkSpacingActions {
  const inner = createScaleGroupActions(helpers, {
    family: 'spacing',
    buildDefault: buildDefaultSpacingGroup,
    makeFresh: makeFreshSpacingGroup,
    nextTabValues: nextSpacingTabValues,
  })

  return {
    toggleFrameworkSpacingDisabled: inner.toggleDisabled,
    createFrameworkSpacingGroup: inner.createGroup,
    updateFrameworkSpacingGroup: inner.updateGroup,
    duplicateFrameworkSpacingGroup: inner.duplicateGroup,
    resetFrameworkSpacingGroup: inner.resetGroup,
    deleteFrameworkSpacingGroup: inner.deleteGroup,
    upsertFrameworkSpacingManualSize: inner.upsertManualSize,
    setFrameworkSpacingClassGenerators: inner.setClassGenerators,
  }
}
