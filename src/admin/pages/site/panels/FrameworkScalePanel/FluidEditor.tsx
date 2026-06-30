import {
  appendStep,
  computeFluidScale,
  effectiveScaleRatio,
  prependStep,
  type FluidScaleStep,
} from '@core/framework'
import type { resolveFrameworkPreferences } from '@core/framework'
import { BaseSettings } from './BaseSettings'
import { ChartHost } from './ChartHost'
import { StepList } from './StepList'
import type { GeneratorShape, GroupShape, ScaleAdapter } from './adapter'
import styles from './FluidEditor.module.css'

/**
 * Fluid mode editor — the "Automatic" branch of the mode toggle. Computes the
 * full per-step scale once via `computeFluidScale` and feeds it to either:
 *
 *   - `ChartHost` (when the adapter supplies `renderChart`, the visualisation
 *     replaces the per-step list — Typography and Spacing both do this),
 *   - `StepList` (the default per-step preview list for adapters without a
 *     dedicated scale visualisation).
 *
 * Step add/remove callbacks live here because they touch `group.steps` AND
 * `group.baseScaleIndex` together — the index has to slide when steps are
 * inserted/removed at the start, and clamp when the list shortens.
 */
export function FluidEditor<G extends GroupShape, C extends GeneratorShape>({
  group,
  adapter,
  preferences,
}: {
  group: G
  adapter: ScaleAdapter<G, C>
  preferences: ReturnType<typeof resolveFrameworkPreferences>
}) {
  const stepLabels = group.steps.split(',').flatMap((step) => {
    const label = step.trim()
    return label ? [label] : []
  })
  const baseScaleIndex = Math.max(0, Math.min(group.baseScaleIndex, stepLabels.length - 1))
  const fluid: FluidScaleStep[] = computeFluidScale({
    minBaseSize: adapter.readBaseSize(group, 'min'),
    maxBaseSize: adapter.readBaseSize(group, 'max'),
    minScaleRatio: effectiveScaleRatio(
      group.min.scaleRatio,
      group.min.isCustomScaleRatio,
      group.min.scaleRatioInputValue,
    ),
    maxScaleRatio: effectiveScaleRatio(
      group.max.scaleRatio,
      group.max.isCustomScaleRatio,
      group.max.scaleRatioInputValue,
    ),
    steps: stepLabels.length,
    baseScaleIndex,
    minScreenWidth: preferences.minScreenWidth,
    maxScreenWidth: preferences.maxScreenWidth,
  })

  // Compute the largest endpoint across the entire scale so per-step charts
  // can scale their bar widths relative to a single shared baseline.
  let largestSizeInScale = 0
  for (const step of fluid) {
    const min = Number(step.min)
    const stepMax = Number(step.max)
    if (Number.isFinite(min) && min > largestSizeInScale) largestSizeInScale = min
    if (Number.isFinite(stepMax) && stepMax > largestSizeInScale) largestSizeInScale = stepMax
  }

  // Build stable input IDs per group so the ControlRow `<label htmlFor>` linkage
  // points to the right field even when the user switches between groups/tabs.
  const fieldId = (key: string) => `scale-${adapter.panelId}-${group.id}-${key}`

  const onPrependStep = () =>
    adapter.onUpdateGroup(group.id, {
      steps: prependStep(group.steps),
      baseScaleIndex: Math.min(baseScaleIndex + 1, stepLabels.length),
    })
  const onAppendStep = () =>
    adapter.onUpdateGroup(group.id, { steps: appendStep(group.steps) })
  const onRemoveFirstStep = () => {
    const next = stepLabels.slice(1).join(',')
    adapter.onUpdateGroup(group.id, {
      steps: next,
      baseScaleIndex: Math.max(0, baseScaleIndex - 1),
    })
  }
  const onRemoveLastStep = () => {
    const next = stepLabels.slice(0, -1).join(',')
    adapter.onUpdateGroup(group.id, {
      steps: next,
      baseScaleIndex: Math.max(0, Math.min(baseScaleIndex, next.split(',').length - 1)),
    })
  }

  return (
    <div className={styles.fluidGrid}>
      <BaseSettings
        group={group}
        adapter={adapter}
        baseScaleIndex={baseScaleIndex}
        stepLabels={stepLabels}
        fieldId={fieldId}
        preferences={preferences}
      />

      <ChartHost
        group={group}
        adapter={adapter}
        fluid={fluid}
        stepLabels={stepLabels}
        baseScaleIndex={baseScaleIndex}
        largestSizeInScale={largestSizeInScale}
        onPrependStep={onPrependStep}
        onAppendStep={onAppendStep}
        onRemoveFirstStep={onRemoveFirstStep}
        onRemoveLastStep={onRemoveLastStep}
      />

      {!adapter.renderChart && (
        <StepList
          group={group}
          adapter={adapter}
          preferences={preferences}
          fluid={fluid}
          stepLabels={stepLabels}
          baseScaleIndex={baseScaleIndex}
          largestSizeInScale={largestSizeInScale}
          onPrependStep={onPrependStep}
          onAppendStep={onAppendStep}
          onRemoveFirstStep={onRemoveFirstStep}
          onRemoveLastStep={onRemoveLastStep}
        />
      )}
    </div>
  )
}
