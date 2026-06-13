/**
 * Framework typography — store actions.
 *
 * The action implementations live in `./scaleGroups.ts` (shared with the
 * spacing family). This file is the thin family-specific wrapper: it binds
 * the generic actions to family-specific names and types so the SiteSlice's
 * external API stays explicit (`createFrameworkTypographyGroup`, not
 * `createGroup`).
 */

import type { SiteDocument } from '@core/page-tree'
import type { FrameworkTypographyGroup } from '@core/framework-schema'
import {
  buildDefaultTypographyGroup,
  makeFreshTypographyGroup,
  nextTypographyTabValues,
} from '@core/framework'
import { createScaleGroupActions } from './scaleGroups'
import type { SiteSlice, SiteSliceHelpers } from '@site/store/slices/site/types'

/**
 * Mirror the field-level effect of `applyFrameworkTypographyGroupPatch`
 * (in siteSlice) on a draft site for the *preview* path. Only fields
 * that influence which utility classes get generated need to be applied
 * — `name` etc. don't affect class IDs or class names so they're
 * intentionally skipped.
 */
export function applyTypographyGroupPatchPreview(
  draft: SiteDocument,
  groupId: string,
  patch: Record<string, unknown>,
): void {
  const tg = draft.settings.framework?.typography
  if (!tg) return
  const group = tg.groups.find((g) => g.id === groupId)
  if (!group) return
  if (typeof patch.namingConvention === 'string') {
    group.namingConvention = patch.namingConvention
  }
  if (typeof patch.steps === 'string') group.steps = patch.steps
  if (typeof patch.mode === 'string') {
    group.mode = patch.mode as FrameworkTypographyGroup['mode']
  }
  if (typeof patch.isDisabled === 'boolean') group.isDisabled = patch.isDisabled
  if (Array.isArray(patch.manualSizes)) {
    group.manualSizes = patch.manualSizes as FrameworkTypographyGroup['manualSizes']
  }
}

type FrameworkTypographyActions = Pick<
  SiteSlice,
  | 'toggleFrameworkTypographyDisabled'
  | 'createFrameworkTypographyGroup'
  | 'updateFrameworkTypographyGroup'
  | 'duplicateFrameworkTypographyGroup'
  | 'resetFrameworkTypographyGroup'
  | 'deleteFrameworkTypographyGroup'
  | 'upsertFrameworkTypographyManualSize'
  | 'setFrameworkTypographyClassGenerators'
>

export function createFrameworkTypographyActions(
  helpers: SiteSliceHelpers,
): FrameworkTypographyActions {
  const inner = createScaleGroupActions(helpers, {
    family: 'typography',
    buildDefault: buildDefaultTypographyGroup,
    makeFresh: makeFreshTypographyGroup,
    nextTabValues: nextTypographyTabValues,
  })

  return {
    toggleFrameworkTypographyDisabled: inner.toggleDisabled,
    createFrameworkTypographyGroup: inner.createGroup,
    updateFrameworkTypographyGroup: inner.updateGroup,
    duplicateFrameworkTypographyGroup: inner.duplicateGroup,
    resetFrameworkTypographyGroup: inner.resetGroup,
    deleteFrameworkTypographyGroup: inner.deleteGroup,
    upsertFrameworkTypographyManualSize: inner.upsertManualSize,
    setFrameworkTypographyClassGenerators: inner.setClassGenerators,
  }
}
