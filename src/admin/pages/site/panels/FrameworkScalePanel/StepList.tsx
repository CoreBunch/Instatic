import { Button } from '@ui/components/Button'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { declarationFromStep, type FluidScaleStep } from '@core/framework'
import type { resolveFrameworkPreferences } from '@core/framework'
import type { GeneratorShape, GroupShape, ScaleAdapter } from './adapter'
import styles from './StepList.module.css'
import { copyToClipboard } from '@admin/lib/clipboard'

interface StepListProps<G extends GroupShape, C extends GeneratorShape> {
  group: G
  adapter: ScaleAdapter<G, C>
  preferences: ReturnType<typeof resolveFrameworkPreferences>
  fluid: FluidScaleStep[]
  stepLabels: string[]
  baseScaleIndex: number
  largestSizeInScale: number
  onPrependStep: () => void
  onAppendStep: () => void
  onRemoveFirstStep: () => void
  onRemoveLastStep: () => void
}

/**
 * Per-step preview list. Renders a card per step with a copyable variable
 * name, the min/max numeric pair, and a per-step body. The body comes from
 * `adapter.renderStepBody` if supplied, otherwise from the simple two-column
 * `adapter.renderPreview` for each endpoint.
 *
 * Header / footer rows host the +/− step add/remove buttons. This component
 * is only mounted when `adapter.renderChart` is NOT supplied — when the
 * adapter draws a single chart card above instead, that card owns the step
 * controls (see ChartHost).
 */
export function StepList<G extends GroupShape, C extends GeneratorShape>({
  group,
  adapter,
  preferences,
  fluid,
  stepLabels,
  baseScaleIndex,
  largestSizeInScale,
  onPrependStep,
  onAppendStep,
  onRemoveFirstStep,
  onRemoveLastStep,
}: StepListProps<G, C>) {
  return (
    <div className={styles.stepList}>
      <div className={styles.stepListHeader}>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Add step before"
          onClick={onPrependStep}
        >
          <PlusIcon size={12} />
        </Button>
        <span className={styles.stepListHeaderLabel}>Steps</span>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Remove first step"
          disabled={stepLabels.length <= 1}
          onClick={onRemoveFirstStep}
        >
          <MinusIcon size={12} />
        </Button>
      </div>

      <ul className={styles.steps} role="list">
        {fluid.map((step, idx) => {
          const stepLabel = stepLabels[idx] ?? ''
          const variableName = `--${group.namingConvention}-${stepLabel}`
          const previewMin = Number(step.min)
          const previewMax = Number(step.max)
          const tooltip = `${variableName} → ${declarationFromStep(step, preferences.isRem ? 'rem' : 'px', preferences.rootFontSize)}`
          const stepBody = adapter.renderStepBody?.({
            minPx: previewMin,
            maxPx: previewMax,
            maxInScale: largestSizeInScale,
            stepLabel,
            variableName,
          })
          return (
            <li
              key={`${stepLabel}-${idx}`}
              className={styles.stepRow}
              data-active={idx === baseScaleIndex ? 'true' : undefined}
            >
              <div className={styles.stepHeader}>
                <Button
                  variant="ghost"
                  size="xs"
                  className={styles.stepName}
                  tooltip={tooltip}
                  aria-label={`Copy ${variableName}`}
                  onClick={() => { void copyToClipboard(`var(${variableName})`) }}
                >
                  {variableName}
                </Button>
                <span className={styles.stepHeaderMeta}>
                  {step.min} / {step.max} px
                </span>
              </div>
              {stepBody !== undefined ? (
                stepBody
              ) : (
                <div className={styles.stepBreakpoints}>
                  <div className={styles.stepPreviewCol}>
                    <span className={styles.stepNumeric}>{step.min}px</span>
                    <span className={styles.stepPreviewSlot}>
                      {adapter.renderPreview(previewMin)}
                    </span>
                  </div>
                  <div className={styles.stepPreviewCol}>
                    <span className={styles.stepNumeric}>{step.max}px</span>
                    <span className={styles.stepPreviewSlot}>
                      {adapter.renderPreview(previewMax)}
                    </span>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {adapter.chartLegend && <div>{adapter.chartLegend}</div>}

      <div className={styles.stepListFooter}>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Add step after"
          onClick={onAppendStep}
        >
          <PlusIcon size={12} />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Remove last step"
          disabled={stepLabels.length <= 1}
          onClick={onRemoveLastStep}
        >
          <MinusIcon size={12} />
        </Button>
      </div>
    </div>
  )
}
