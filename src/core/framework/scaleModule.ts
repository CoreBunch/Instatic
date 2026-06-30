/**
 * Shared engine that turns a "framework scale" configuration (typography OR
 * spacing) into:
 *   - the flat list of CSS custom properties at `:root`,
 *   - the rendered `:root { … }` block,
 *   - the per-step utility classes (e.g. `.text-xs`, `.padding-m`, …).
 *
 * Typography and spacing are sister modules: the math, the variable-naming
 * convention, the `mode === 'fluid_manual'` branch, the class-pattern
 * expansion (`*` and `{step}`) — all identical. The only differences are:
 *
 *   - the per-group base size lives at `group.min.size` for spacing and
 *     `group.min.fontSize` for typography (`getMinBaseSize` / `getMaxBaseSize`),
 *   - the CSS property whitelist (`propertyKeymap`),
 *   - the class id prefix and the `family` discriminator in
 *     `GeneratedClassMetadata`,
 *   - the `tags` array on the emitted `StyleRule`.
 *
 * Both `framework/typography.ts` and `framework/spacing.ts` are now thin
 * adapters that call this factory with their type-specific extractors.
 */

import type { StyleRule, CSSPropertyBag } from '@core/page-tree'
import { classKindSelector } from '@core/page-tree'
import type { FrameworkScaleManualSize, FrameworkScaleMode } from '@core/framework-schema'
import {
  computeFluidScale,
  convertToVariableDeclarationName,
  declarationFromStep,
  effectiveScaleRatio,
  type FrameworkPreferences,
  getVariableName,
  manualSizeVariableName,
} from './scale'

// ---------------------------------------------------------------------------
// Public types — shared between typography and spacing
// ---------------------------------------------------------------------------

type FrameworkScaleFamily = 'spacing' | 'typography'

/** Output shape — same for typography and spacing. */
export interface FrameworkScaleVariable {
  name: string
  value: string
  groupId: string
  groupName: string
  /** Step suffix as it appears in the user-defined `steps` string ("xs", "m"…). */
  step: string
  /** Manual sizes have an arbitrary CSS-safe name instead of a step. */
  manualName?: string
}

type FrameworkStyleTarget = keyof CSSPropertyBag | readonly (keyof CSSPropertyBag)[]

/** A group paired with its parsed step labels — computed once per generation. */
interface FrameworkScaleGroupEntry<TGroup> {
  group: TGroup
  stepLabels: string[]
}

/**
 * The ordered group enumeration shared between the variable pass and the
 * utility-class pass. Building it once (sort + step-label parse) means a single
 * traversal per family feeds both outputs instead of two independent ones.
 */
interface FrameworkScalePlan<
  TGroup extends FrameworkScaleGroupCommon,
  TGenerator extends FrameworkClassGeneratorCommon,
> {
  /** Ordered, non-disabled groups with their parsed step labels. */
  groups: FrameworkScaleGroupEntry<TGroup>[]
  groupsById: Map<string, FrameworkScaleGroupEntry<TGroup>>
  generators: TGenerator[]
}

/** Both scale outputs derived from one shared plan. */
interface FrameworkScalePlanResult {
  variables: FrameworkScaleVariable[]
  utilityClasses: Record<string, StyleRule>
}

// ---------------------------------------------------------------------------
// Generic shape of a framework scale group / settings — what the factory
// actually needs to do its work, irrespective of family.
// ---------------------------------------------------------------------------

interface FrameworkScaleGroupCommon {
  id: string
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  manualSizes?: FrameworkScaleManualSize[]
  isDisabled?: boolean
  order: number
  updatedAt: number
}

interface FrameworkScaleSettingsCommon<TGroup, TGenerator> {
  groups: TGroup[]
  classes?: TGenerator[]
  isDisabled?: boolean
}

interface FrameworkClassGeneratorCommon {
  id: string
  name: string
  property: string[]
  tabId: string
  isDisabled?: boolean
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface FrameworkScaleModuleConfig<TGroup extends FrameworkScaleGroupCommon> {
  family: FrameworkScaleFamily
  /** Reads the per-breakpoint base size off a group (`size` for spacing, `fontSize` for typography). */
  getMinBaseSize: (group: TGroup) => number
  getMaxBaseSize: (group: TGroup) => number
  /** Per-breakpoint extractor for the scale ratio (lives on `min`/`max` for both families). */
  getMinScaleConfig: (group: TGroup) => {
    scaleRatio: number | string
    isCustomScaleRatio?: boolean
    scaleRatioInputValue?: number
  }
  getMaxScaleConfig: (group: TGroup) => {
    scaleRatio: number | string
    isCustomScaleRatio?: boolean
    scaleRatioInputValue?: number
  }
  /** Maps CSS property tokens (`font-size`, `padding`, …) to `CSSPropertyBag` keys. */
  propertyKeymap: Record<string, FrameworkStyleTarget>
  /** Tags applied to every generated `StyleRule` — e.g. `['framework', 'utility', 'spacing']`. */
  classTags: string[]
}

interface FrameworkScaleModule<
  TGroup extends FrameworkScaleGroupCommon,
  TGenerator extends FrameworkClassGeneratorCommon,
> {
  generateVariables(
    settings: FrameworkScaleSettingsCommon<TGroup, TGenerator> | null | undefined,
    preferences: FrameworkPreferences,
  ): FrameworkScaleVariable[]
  generateUtilityClasses(
    settings: FrameworkScaleSettingsCommon<TGroup, TGenerator> | null | undefined,
  ): Record<string, StyleRule>
  /** Variables + utility classes from a single shared group enumeration. */
  generatePlan(
    settings: FrameworkScaleSettingsCommon<TGroup, TGenerator> | null | undefined,
    preferences: FrameworkPreferences,
  ): FrameworkScalePlanResult
}

export function createFrameworkScaleModule<
  TGroup extends FrameworkScaleGroupCommon,
  TGenerator extends FrameworkClassGeneratorCommon,
>(config: FrameworkScaleModuleConfig<TGroup>): FrameworkScaleModule<TGroup, TGenerator> {
  const {
    family,
    getMinBaseSize,
    getMaxBaseSize,
    getMinScaleConfig,
    getMaxScaleConfig,
    propertyKeymap,
    classTags,
  } = config

  function fluidVariables(
    group: TGroup,
    stepLabels: string[],
    preferences: FrameworkPreferences,
    targetUnit: 'px' | 'rem',
  ): FrameworkScaleVariable[] {
    const min = getMinScaleConfig(group)
    const max = getMaxScaleConfig(group)
    const minRatio = effectiveScaleRatio(min.scaleRatio, min.isCustomScaleRatio, min.scaleRatioInputValue)
    const maxRatio = effectiveScaleRatio(max.scaleRatio, max.isCustomScaleRatio, max.scaleRatioInputValue)

    const fluidSteps = computeFluidScale({
      minBaseSize: Number(getMinBaseSize(group)),
      maxBaseSize: Number(getMaxBaseSize(group)),
      minScaleRatio: minRatio,
      maxScaleRatio: maxRatio,
      steps: stepLabels.length,
      baseScaleIndex: group.baseScaleIndex,
      minScreenWidth: preferences.minScreenWidth,
      maxScreenWidth: preferences.maxScreenWidth,
    })

    return fluidSteps.map((step, idx) => {
      const stepLabel = stepLabels[idx]
      return {
        name: getVariableName(group.namingConvention, stepLabel),
        value: declarationFromStep(step, targetUnit, preferences.rootFontSize),
        groupId: group.id,
        groupName: group.name,
        step: stepLabel,
      }
    })
  }

  function manualVariables(
    group: TGroup,
    stepLabels: string[],
    preferences: FrameworkPreferences,
    targetUnit: 'px' | 'rem',
  ): FrameworkScaleVariable[] {
    const items = group.manualSizes ?? []
    return items.map((size, idx) => {
      const fluid = computeFluidScale({
        minBaseSize: Number(size.min),
        maxBaseSize: Number(size.max),
        minScaleRatio: 1,
        maxScaleRatio: 1,
        steps: 1,
        baseScaleIndex: 0,
        minScreenWidth: preferences.minScreenWidth,
        maxScreenWidth: preferences.maxScreenWidth,
      })[0]
      return {
        name: convertToVariableDeclarationName(manualSizeVariableName(size.name)),
        value: declarationFromStep(fluid, targetUnit, preferences.rootFontSize),
        groupId: group.id,
        groupName: group.name,
        step: stepLabels[idx] ?? size.name,
        manualName: size.name,
      }
    })
  }

  /**
   * Build the ordered group enumeration once: sort groups, drop disabled ones,
   * and parse each surviving group's step labels. Both passes consume this so
   * the sort + step parse is not repeated. Returns null when the family is
   * absent or disabled (no groups to plan).
   */
  function planGroups(
    settings: FrameworkScaleSettingsCommon<TGroup, TGenerator> | null | undefined,
  ): FrameworkScalePlan<TGroup, TGenerator> | null {
    if (!settings || settings.isDisabled) return null
    const groups: FrameworkScaleGroupEntry<TGroup>[] = []
    for (const group of orderedGroups(settings.groups)) {
      if (group.isDisabled) continue
      groups.push({ group, stepLabels: stepLabelsForGroup(group) })
    }
    const groupsById = new Map(groups.map((entry) => [entry.group.id, entry]))
    return { groups, groupsById, generators: settings.classes ?? [] }
  }

  function variablesFromPlan(
    plan: FrameworkScalePlan<TGroup, TGenerator> | null,
    preferences: FrameworkPreferences,
  ): FrameworkScaleVariable[] {
    if (!plan) return []
    const targetUnit = preferences.isRem ? 'rem' : 'px'
    const variables: FrameworkScaleVariable[] = []

    for (const { group, stepLabels } of plan.groups) {
      if (group.mode === 'fluid_manual') {
        variables.push(...manualVariables(group, stepLabels, preferences, targetUnit))
      } else {
        variables.push(...fluidVariables(group, stepLabels, preferences, targetUnit))
      }
    }

    return variables
  }

  function generateVariables(
    settings: FrameworkScaleSettingsCommon<TGroup, TGenerator> | null | undefined,
    preferences: FrameworkPreferences,
  ): FrameworkScaleVariable[] {
    return variablesFromPlan(planGroups(settings), preferences)
  }

  function utilityClassesFromPlan(
    plan: FrameworkScalePlan<TGroup, TGenerator> | null,
  ): Record<string, StyleRule> {
    const classes: Record<string, StyleRule> = {}
    if (!plan) return classes

    for (const generator of plan.generators) {
      if (generator.isDisabled) continue
      if (!generator.tabId) continue
      const entry = plan.groupsById.get(generator.tabId)
      if (!entry) continue
      const { group, stepLabels } = entry

      for (let stepIdx = 0; stepIdx < stepLabels.length; stepIdx += 1) {
        const step = stepLabels[stepIdx]
        const className = expandClassPattern(generator.name, step)
        if (!className) continue

        const variableName =
          group.mode === 'fluid_manual'
            ? convertToVariableDeclarationName(
                manualSizeVariableName(
                  group.manualSizes?.[stepIdx]?.name ?? `${group.namingConvention}-${step}`,
                ),
              )
            : getVariableName(group.namingConvention, step)

        const styles = buildUtilityStyles(propertyKeymap, generator.property, `var(${variableName})`)
        const id = `framework:${family}:${group.id}:${generator.id}:${step}`
        // Static-0 contract: generated utility classes must be a pure function of
        // settings. `updatedAt` defaults to 0 in the schema; the reconciler
        // preserves real timestamps, so falling back to 0 (not Date.now()) keeps
        // generateUtilityClasses deterministic.
        const now = group.updatedAt || 0
        classes[id] = {
          id,
          name: className,
          kind: 'class',
          selector: classKindSelector(className),
          order: 0,
          styles,
          contextStyles: {},
          generated: {
            origin: 'framework',
            family,
            sourceId: group.id,
            generatorId: generator.id,
            tokenName: group.namingConvention,
            step,
            locked: true,
          },
          tags: classTags,
          createdAt: now,
          updatedAt: now,
        }
      }
    }

    return classes
  }

  function generateUtilityClasses(
    settings: FrameworkScaleSettingsCommon<TGroup, TGenerator> | null | undefined,
  ): Record<string, StyleRule> {
    return utilityClassesFromPlan(planGroups(settings))
  }

  function generatePlan(
    settings: FrameworkScaleSettingsCommon<TGroup, TGenerator> | null | undefined,
    preferences: FrameworkPreferences,
  ): FrameworkScalePlanResult {
    const plan = planGroups(settings)
    return {
      variables: variablesFromPlan(plan, preferences),
      utilityClasses: utilityClassesFromPlan(plan),
    }
  }

  return { generateVariables, generateUtilityClasses, generatePlan }
}

// ---------------------------------------------------------------------------
// Internals — independent of family
// ---------------------------------------------------------------------------

function orderedGroups<T extends { order: number }>(groups: T[]): T[] {
  return [...groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

function stepLabelsForGroup(group: { steps: string }): string[] {
  return group.steps
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function expandClassPattern(pattern: string, step: string): string {
  const trimmed = pattern.trim().replace(/^\./, '')
  if (!trimmed) return ''
  if (trimmed.includes('*')) return trimmed.replaceAll('*', step)
  if (trimmed.includes('{step}')) return trimmed.replaceAll('{step}', step)
  return `${trimmed}-${step}`
}

function buildUtilityStyles(
  keymap: Record<string, FrameworkStyleTarget>,
  properties: string[],
  value: string,
): Partial<CSSPropertyBag> {
  const styles: Partial<CSSPropertyBag> = {}
  for (const property of properties) {
    const target = keymap[property] ?? toCamelCase(property)
    const keys = Array.isArray(target) ? target : [target]
    for (const key of keys) {
      if (!key) continue
      ;(styles as Record<string, string>)[key] = value
    }
  }
  return styles
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}
