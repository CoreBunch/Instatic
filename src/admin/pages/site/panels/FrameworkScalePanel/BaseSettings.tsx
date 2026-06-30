import { useRef } from 'react'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { ControlRow } from '@ui/components/ControlRow'
import { useEditorStore } from '@site/store/store'
import type { resolveFrameworkPreferences } from '@core/framework'
import { NumericInput } from './controls/NumericInput'
import { RatioField } from './controls/RatioField'
import { RatioModeToggle } from './controls/RatioModeToggle'
import type { GeneratorShape, GroupShape, ScaleAdapter } from './adapter'
import styles from './BaseSettings.module.css'

/**
 * Two-column grid of fluid-mode settings. Each base-size row pairs the size
 * with the screen width it applies at — the two clamp endpoints — so the
 * relationship driving the `clamp()` is explicit ("16px at 320px → 18px at
 * 1400px"). The screen widths are the site-wide framework preferences
 * (shared across every scale), edited in place via `updateFrameworkPreferences`.
 *
 * Below the ratios, base step + step list share one row (1fr / 3fr). The grid
 * also anchors the ratio Selects' menus so their long preset labels span the
 * full width instead of being clipped to a single column.
 */
export function BaseSettings<G extends GroupShape, C extends GeneratorShape>({
  group,
  adapter,
  baseScaleIndex,
  stepLabels,
  fieldId,
  preferences,
}: {
  group: G
  adapter: ScaleAdapter<G, C>
  baseScaleIndex: number
  stepLabels: string[]
  fieldId: (key: string) => string
  preferences: ReturnType<typeof resolveFrameworkPreferences>
}) {
  const updateFrameworkPreferences = useEditorStore((s) => s.updateFrameworkPreferences)

  // Anchor element for the ratio Selects' dropdowns. Each Select trigger lives
  // in a 2-column grid cell that's too narrow for the long ratio labels
  // ("Augmented Fourth (1.414...)" etc.), so we let their menus span the full
  // width of `.baseSettings` instead of getting truncated to one column.
  const baseSettingsRef = useRef<HTMLDivElement>(null)
  const baseSizeLabel = adapter.baseSizeLabel.toLowerCase()

  return (
    <div ref={baseSettingsRef} className={styles.baseSettings}>
      <div className={styles.fullRow}>
        <ControlRow
          propKey="min-base-size"
          inputId={fieldId('min-base-size')}
          label={`Min ${baseSizeLabel}`}
          layout="stacked"
        >
          <div className={styles.sizeAtWidth}>
            <NumericInput
              inputId={fieldId('min-base-size')}
              value={adapter.readBaseSize(group, 'min')}
              ariaLabel={`Min ${baseSizeLabel}`}
              onChange={(next) => adapter.onUpdateGroup(group.id, adapter.patchBaseSize('min', next))}
              unit="px"
            />
            <span className={styles.sizeAtSep}>at</span>
            <NumericInput
              value={preferences.minScreenWidth}
              ariaLabel="Min screen width"
              onChange={(next) => updateFrameworkPreferences({ minScreenWidth: next })}
              unit="px"
            />
          </div>
        </ControlRow>
      </div>
      <div className={styles.fullRow}>
        <ControlRow
          propKey="max-base-size"
          inputId={fieldId('max-base-size')}
          label={`Max ${baseSizeLabel}`}
          layout="stacked"
        >
          <div className={styles.sizeAtWidth}>
            <NumericInput
              inputId={fieldId('max-base-size')}
              value={adapter.readBaseSize(group, 'max')}
              ariaLabel={`Max ${baseSizeLabel}`}
              onChange={(next) => adapter.onUpdateGroup(group.id, adapter.patchBaseSize('max', next))}
              unit="px"
            />
            <span className={styles.sizeAtSep}>at</span>
            <NumericInput
              value={preferences.maxScreenWidth}
              ariaLabel="Max screen width"
              onChange={(next) => updateFrameworkPreferences({ maxScreenWidth: next })}
              unit="px"
            />
          </div>
        </ControlRow>
      </div>

      <ControlRow
        propKey="min-ratio"
        inputId={fieldId('min-ratio')}
        label="Min ratio"
        layout="stacked"
        labelSuffix={
          <RatioModeToggle
            isCustom={Boolean(group.min.isCustomScaleRatio)}
            ariaLabel="Toggle custom min scale ratio"
            onToggle={() =>
              adapter.onUpdateGroup(group.id, {
                min: {
                  ...group.min,
                  isCustomScaleRatio: !group.min.isCustomScaleRatio,
                  scaleRatioInputValue:
                    group.min.scaleRatioInputValue ?? Number(group.min.scaleRatio),
                },
              })
            }
          />
        }
      >
        <RatioField
          inputId={fieldId('min-ratio')}
          scaleRatio={group.min.scaleRatio}
          isCustom={group.min.isCustomScaleRatio}
          customValue={group.min.scaleRatioInputValue}
          options={adapter.ratioOptions}
          ariaLabel="Min scale ratio"
          menuAnchorRef={baseSettingsRef}
          onChange={(patch) =>
            adapter.onUpdateGroup(group.id, { min: { ...group.min, ...patch } })
          }
        />
      </ControlRow>
      <ControlRow
        propKey="max-ratio"
        inputId={fieldId('max-ratio')}
        label="Max ratio"
        layout="stacked"
        labelSuffix={
          <RatioModeToggle
            isCustom={Boolean(group.max.isCustomScaleRatio)}
            ariaLabel="Toggle custom max scale ratio"
            onToggle={() =>
              adapter.onUpdateGroup(group.id, {
                max: {
                  ...group.max,
                  isCustomScaleRatio: !group.max.isCustomScaleRatio,
                  scaleRatioInputValue:
                    group.max.scaleRatioInputValue ?? Number(group.max.scaleRatio),
                },
              })
            }
          />
        }
      >
        <RatioField
          inputId={fieldId('max-ratio')}
          scaleRatio={group.max.scaleRatio}
          isCustom={group.max.isCustomScaleRatio}
          customValue={group.max.scaleRatioInputValue}
          options={adapter.ratioOptions}
          ariaLabel="Max scale ratio"
          menuAnchorRef={baseSettingsRef}
          onChange={(patch) =>
            adapter.onUpdateGroup(group.id, { max: { ...group.max, ...patch } })
          }
        />
      </ControlRow>

      <div className={styles.baseAndSteps}>
        <ControlRow
          propKey="base-step"
          inputId={fieldId('base-step')}
          label="Base step"
          layout="stacked"
        >
          <Select
            id={fieldId('base-step')}
            fieldSize="sm"
            aria-label="Base scale index"
            value={String(baseScaleIndex)}
            options={stepLabels.map((label, idx) => ({ value: String(idx), label }))}
            onChange={(event) =>
              adapter.onUpdateGroup(group.id, { baseScaleIndex: Number(event.currentTarget.value) })
            }
          />
        </ControlRow>
        <ControlRow
          propKey="steps"
          inputId={fieldId('steps')}
          label="Steps"
          layout="stacked"
        >
          <Input
            id={fieldId('steps')}
            fieldSize="sm"
            aria-label="Step labels"
            value={group.steps}
            onChange={(event) => adapter.onUpdateGroup(group.id, { steps: event.target.value })}
            monospace
          />
        </ControlRow>
      </div>
    </div>
  )
}
