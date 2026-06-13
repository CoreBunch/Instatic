/**
 * Generic action factory for the two parallel "fluid scale" families:
 * typography and spacing.
 *
 * The two families have identical store-action shapes — toggle disabled,
 * create/update/duplicate/reset/delete a group, upsert a manual size, replace
 * the class-generator list. Only the underlying types and a handful of
 * factory functions differ.
 *
 * `createScaleGroupActions` is family-agnostic: callers from spacing.ts and
 * typography.ts pass family-specific types and helpers via `ScaleFamilyConfig`
 * and a `'typography' | 'spacing'` discriminator (used to read/write the right
 * branch of `site.settings.framework`).
 */

import { nanoid } from 'nanoid'
import type { SiteDocument } from '@core/page-tree'
import type {
  FrameworkScaleManualSize,
  FrameworkSpacingClassGenerator,
  FrameworkSpacingGroup,
  FrameworkSpacingSettings,
  FrameworkTypographyClassGenerator,
  FrameworkTypographyGroup,
  FrameworkTypographySettings,
} from '@core/framework-schema'
import { reconcileFrameworkClasses } from './reconcile'
import { nextOrderValue } from './shared'
import type {
  SiteSliceHelpers,
  UpdateFrameworkSpacingGroupPatch,
  UpdateFrameworkTypographyGroupPatch,
} from '@site/store/slices/site/types'

// ---------------------------------------------------------------------------
// Family parameterization
// ---------------------------------------------------------------------------

/**
 * Map a family discriminator to the four generic parameters that change per
 * family: the group type, the patch type, the settings branch type, and the
 * class-generator list type.
 */
interface ScaleFamilyTypes {
  typography: {
    Group: FrameworkTypographyGroup
    Patch: UpdateFrameworkTypographyGroupPatch
    Settings: FrameworkTypographySettings
    ClassGenerator: FrameworkTypographyClassGenerator
  }
  spacing: {
    Group: FrameworkSpacingGroup
    Patch: UpdateFrameworkSpacingGroupPatch
    Settings: FrameworkSpacingSettings
    ClassGenerator: FrameworkSpacingClassGenerator
  }
}

interface ScaleFamilyConfig<F extends 'typography' | 'spacing'> {
  family: F
  buildDefault: (order: number) => ScaleFamilyTypes[F]['Group']
  makeFresh: (
    name: string,
    varName: string,
    order: number,
  ) => ScaleFamilyTypes[F]['Group']
  nextTabValues: (
    groups: Array<ScaleFamilyTypes[F]['Group']>,
  ) => { name: string; varName: string }
}

// ---------------------------------------------------------------------------
// Internal helpers — shared by both families
// ---------------------------------------------------------------------------

/**
 * Lazily materialise `site.settings.framework[family]` and its `groups` /
 * `classes` arrays. The two family branches have structurally identical
 * shapes, so a single helper covers both.
 */
function ensureScaleSettings<F extends 'typography' | 'spacing'>(
  site: SiteDocument,
  family: F,
): ScaleFamilyTypes[F]['Settings'] {
  if (!site.settings.framework) {
    site.settings.framework = { colors: { tokens: [] } }
  }
  const framework = site.settings.framework
  if (family === 'typography') {
    if (!framework.typography) framework.typography = { groups: [], classes: [] }
    framework.typography.groups ??= []
    framework.typography.classes ??= []
    return framework.typography as ScaleFamilyTypes[F]['Settings']
  }
  if (!framework.spacing) framework.spacing = { groups: [], classes: [] }
  framework.spacing.groups ??= []
  framework.spacing.classes ??= []
  return framework.spacing as ScaleFamilyTypes[F]['Settings']
}

/** Read the family branch off a frozen (read-only) site without mutating. */
function readScaleGroups<F extends 'typography' | 'spacing'>(
  site: SiteDocument,
  family: F,
): Array<ScaleFamilyTypes[F]['Group']> {
  const branch = readScaleSettings(site, family)
  return (branch?.groups ?? []) as Array<ScaleFamilyTypes[F]['Group']>
}

/** Read the family branch off a frozen (read-only) site without mutating. */
function readScaleSettings<F extends 'typography' | 'spacing'>(
  site: SiteDocument,
  family: F,
): ScaleFamilyTypes[F]['Settings'] | null {
  const branch =
    family === 'typography'
      ? site.settings.framework?.typography
      : site.settings.framework?.spacing
  return (branch ?? null) as ScaleFamilyTypes[F]['Settings'] | null
}

/**
 * Subset of `Update*GroupPatch` that the generic patch applier touches. Both
 * family patches structurally extend this shape (with their own `min`/`max`
 * config types narrowed at the call site).
 */
type CommonScaleGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkTypographyGroup['mode']
  isDisabled: boolean
  min: Record<string, unknown>
  max: Record<string, unknown>
  manualSizes: FrameworkScaleManualSize[]
}>

/**
 * Merge a partial patch into a scale group. Both family Group types share the
 * exact set of fields touched here; the call site casts the patch down to the
 * common shape because TypeScript can't unify the two structural patch types
 * automatically.
 */
function applyScaleGroupPatch(
  group: FrameworkTypographyGroup | FrameworkSpacingGroup,
  patch: CommonScaleGroupPatch,
): boolean {
  let changed = false
  function assign<K extends keyof typeof group>(key: K, value: (typeof group)[K]): void {
    if (Object.is(group[key], value)) return
    group[key] = value
    changed = true
  }

  if (patch.name !== undefined) assign('name', patch.name)
  if (patch.namingConvention !== undefined) assign('namingConvention', patch.namingConvention)
  if (patch.steps !== undefined) assign('steps', patch.steps)
  if (patch.baseScaleIndex !== undefined) assign('baseScaleIndex', patch.baseScaleIndex)
  if (patch.mode !== undefined) assign('mode', patch.mode)
  if (patch.isDisabled !== undefined) assign('isDisabled', patch.isDisabled)
  if (patch.min) {
    const min = group.min as Record<string, unknown>
    if (Object.entries(patch.min).some(([key, value]) => !Object.is(min[key], value))) {
      Object.assign(min, patch.min)
      changed = true
    }
  }
  if (patch.max) {
    const max = group.max as Record<string, unknown>
    if (Object.entries(patch.max).some(([key, value]) => !Object.is(max[key], value))) {
      Object.assign(max, patch.max)
      changed = true
    }
  }
  if (patch.manualSizes !== undefined) {
    assign('manualSizes', patch.manualSizes)
  }
  if (changed) group.updatedAt = Date.now()
  return changed
}

// ---------------------------------------------------------------------------
// Action factory
// ---------------------------------------------------------------------------

interface ScaleGroupActions<F extends 'typography' | 'spacing'> {
  toggleDisabled: () => void
  createGroup: () => ScaleFamilyTypes[F]['Group']
  updateGroup: (groupId: string, patch: ScaleFamilyTypes[F]['Patch']) => void
  duplicateGroup: (groupId: string) => ScaleFamilyTypes[F]['Group'] | null
  resetGroup: (groupId: string) => void
  deleteGroup: (groupId: string) => void
  upsertManualSize: (
    groupId: string,
    sizeId: string,
    patch: Partial<{ name: string; min: number; max: number }>,
  ) => void
  setClassGenerators: (
    classes: ScaleFamilyTypes[F]['ClassGenerator'][],
  ) => void
}

/**
 * Build the action set for one scale family. The returned object uses generic
 * names (`createGroup`, etc.) that the per-family wrapper in `spacing.ts` /
 * `typography.ts` re-exposes under family-specific names like
 * `createFrameworkSpacingGroup`.
 */
export function createScaleGroupActions<F extends 'typography' | 'spacing'>(
  helpers: SiteSliceHelpers,
  config: ScaleFamilyConfig<F>,
): ScaleGroupActions<F> {
  const { get, mutateSite } = helpers
  const { family, buildDefault, makeFresh, nextTabValues } = config

  return {
    toggleDisabled: () => {
      mutateSite((site) => {
        const settings = ensureScaleSettings(site, family)
        settings.isDisabled = !settings.isDisabled
        reconcileFrameworkClasses(site)
        return true
      })
    },

    createGroup: () => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      // Read-only view of the (Immer-frozen) live site — `ensureScaleSettings`
      // mutates and would throw on the frozen object when the family branch is
      // absent. The actual write happens inside `mutateSite` below.
      const groups = readScaleGroups(site, family)
      const { name, varName } = nextTabValues(groups)
      const order = nextOrderValue(groups)
      const group = makeFresh(name, varName, order)

      mutateSite((draftSite) => {
        const draftSettings = ensureScaleSettings(draftSite, family)
        ;(draftSettings.groups as Array<ScaleFamilyTypes[F]['Group']>).push(group)
        reconcileFrameworkClasses(draftSite)
        return true
      })
      return group
    },

    updateGroup: (groupId, patch) => {
      mutateSite((site) => {
        const settings = readScaleSettings(site, family)
        if (!settings) return false
        const group = (settings.groups as Array<ScaleFamilyTypes[F]['Group']>).find(
          (g) => g.id === groupId,
        )
        if (!group) return false
        if (!applyScaleGroupPatch(group, patch as CommonScaleGroupPatch)) return false
        reconcileFrameworkClasses(site)
        return true
      })
    },

    duplicateGroup: (groupId) => {
      const { site } = get()
      if (!site) return null
      // Read-only view — see note in createGroup.
      const groups = readScaleGroups(site, family)
      const source = groups.find((g) => g.id === groupId)
      if (!source) return null

      const { name, varName } = nextTabValues(groups)
      const order = nextOrderValue(groups)
      const now = Date.now()
      const sourceClone = structuredClone(source)
      const copy = {
        ...sourceClone,
        id: nanoid(),
        name,
        namingConvention: varName,
        manualSizes: source.manualSizes?.map((m) => ({
          ...m,
          id: nanoid(),
          name: m.name.replace(source.namingConvention, varName),
        })),
        order,
        createdAt: now,
        updatedAt: now,
      } as ScaleFamilyTypes[F]['Group']

      mutateSite((draftSite) => {
        const draftSettings = ensureScaleSettings(draftSite, family)
        ;(draftSettings.groups as Array<ScaleFamilyTypes[F]['Group']>).push(copy)
        reconcileFrameworkClasses(draftSite)
        return true
      })
      return copy
    },

    resetGroup: (groupId) => {
      mutateSite((site) => {
        const settings = readScaleSettings(site, family)
        if (!settings) return false
        const groups = settings.groups as Array<ScaleFamilyTypes[F]['Group']>
        const idx = groups.findIndex((g) => g.id === groupId)
        if (idx < 0) return false
        const order = groups[idx].order
        groups[idx] = { ...buildDefault(order), id: groupId }
        reconcileFrameworkClasses(site)
        return true
      })
    },

    deleteGroup: (groupId) => {
      mutateSite((site) => {
        const settings = readScaleSettings(site, family)
        if (!settings) return false
        if (!settings.groups.some((g: { id: string }) => g.id === groupId)) return false
        settings.groups = settings.groups.filter(
          (g: { id: string }) => g.id !== groupId,
        ) as ScaleFamilyTypes[F]['Settings']['groups']
        settings.classes = (
          settings.classes?.filter((c: { tabId: string }) => c.tabId !== groupId) ?? []
        ) as ScaleFamilyTypes[F]['Settings']['classes']
        reconcileFrameworkClasses(site)
        return true
      })
    },

    upsertManualSize: (groupId, sizeId, patch) => {
      mutateSite((site) => {
        const settings = readScaleSettings(site, family)
        if (!settings) return false
        const group = (settings.groups as Array<ScaleFamilyTypes[F]['Group']>).find(
          (g) => g.id === groupId,
        )
        if (!group) return false
        const manualSizes = group.manualSizes ?? []
        const idx = manualSizes.findIndex((m) => m.id === sizeId)
        if (idx < 0) {
          if (
            typeof patch.name !== 'string' ||
            typeof patch.min !== 'number' ||
            typeof patch.max !== 'number'
          ) {
            return false
          }
          group.manualSizes ??= []
          group.manualSizes.push({
            id: sizeId,
            name: patch.name,
            min: patch.min,
            max: patch.max,
          })
        } else {
          const current = manualSizes[idx]
          const changed = Object.entries(patch).some(
            ([key, value]) => !Object.is(current[key as keyof typeof current], value),
          )
          if (!changed) return false
          group.manualSizes![idx] = { ...current, ...patch }
        }
        group.updatedAt = Date.now()
        reconcileFrameworkClasses(site)
        return true
      })
    },

    setClassGenerators: (classes) => {
      mutateSite((site) => {
        const settings = ensureScaleSettings(site, family)
        settings.classes =
          classes as ScaleFamilyTypes[F]['Settings']['classes']
        reconcileFrameworkClasses(site)
        return true
      })
    },
  }
}
