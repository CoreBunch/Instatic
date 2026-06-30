/**
 * TypographyPanel — docked sidebar UI for fluid type scales.
 *
 * Thin wrapper around the shared `FrameworkScalePanel` with a typography-specific
 * adapter (base size lives at `min.fontSize` / `max.fontSize`, ratio options
 * stop at the Major Sixth, the scale preview is an open text specimen list,
 * and the Class Generator targets `font-size` / line-height / letter-spacing
 * properties).
 */

import { type CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import { TYPE_RATIO_OPTIONS } from '@core/framework'
import type {
  FrameworkTypographyClassGenerator,
  FrameworkTypographyGroup,
} from '@core/framework-schema'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { TextColumsIcon } from 'pixel-art-icons/icons/text-colums'
import { Button } from '@ui/components/Button'
import {
  FrameworkScalePanel,
  type ScaleAdapter,
} from '@site/panels/FrameworkScalePanel'
import { useFrameworkChangeConfirm } from '@admin/shared/dialogs/FrameworkChangeConfirmDialog'
import { applyTypographyGroupPatchPreview } from '@site/store/slices/site/framework/typography'
import { FontsSection } from './FontsSection/FontsSection'
import styles from './TypographyPanel.module.css'

const TYPOGRAPHY_CSS_PROPERTIES = [
  { value: 'font-size', label: 'font-size' },
  { value: 'line-height', label: 'line-height' },
  { value: 'letter-spacing', label: 'letter-spacing' },
] as const

const EMPTY_GROUPS: FrameworkTypographyGroup[] = []
const EMPTY_CLASSES: FrameworkTypographyClassGenerator[] = []

interface TypographyScalePoint {
  stepLabel: string
  variableName: string
  minPx: number
  maxPx: number
  isBase: boolean
}

function groupActionLabel(prefix: string, groupId: string): string {
  // The dialog header gets shortened — prefer "<prefix>" without the
  // raw group ID. Group name is unknown at this layer; the prefix
  // alone is informative enough.
  void groupId
  return prefix
}

function formatTypeValue(value: number): string {
  if (!Number.isFinite(value)) return ''
  return value.toFixed(2).replace(/\.?0+$/, '')
}

function copyToClipboard(value: string) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return
  void navigator.clipboard.writeText(value).catch(() => {})
}

function TypographyScalePreview({ points }: { points: TypographyScalePoint[] }) {
  return (
    <ol
      className={styles.scalePreview}
      aria-label="Typography scale preview"
    >
      {points.map((point, idx) => {
        const minLabel = formatTypeValue(point.minPx)
        const maxLabel = formatTypeValue(point.maxPx)
        const variableValue = `var(${point.variableName})`
        return (
          <li
            key={`${point.stepLabel}-${idx}`}
            className={styles.typeSpecimen}
            data-base={point.isBase ? 'true' : undefined}
            aria-label={`${point.variableName}, ${minLabel}px mobile, ${maxLabel}px desktop`}
            style={
              {
                '--type-min-size': `${Math.max(8, point.minPx)}px`,
                '--type-max-size': `${Math.max(8, point.maxPx)}px`,
              } as CSSProperties
            }
          >
            <div className={styles.typeSpecimenHeader}>
              <Button
                variant="ghost"
                size="micro"
                shape="flush"
                className={styles.typeTokenButton}
                aria-label={`Copy ${point.variableName}`}
                onClick={() => copyToClipboard(variableValue)}
              >
                {point.variableName}
              </Button>
              <span className={styles.typeRange}>
                {minLabel}
                <span className={styles.typeRangeSeparator}>/</span>
                {maxLabel}
                <span className={styles.typeRangeUnit}> px</span>
              </span>
            </div>
            <div className={styles.typeSpecimenLine} aria-hidden="true">
              <span className={styles.typeSpecimenMin}>Aa</span>
              <span className={styles.typeSpecimenMax}>Aa</span>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export function TypographyTab() {
  const onToggleDisabled = useEditorStore((s) => s.toggleFrameworkTypographyDisabled)
  const onCreateGroup = useEditorStore((s) => s.createFrameworkTypographyGroup)
  const onUpdateGroup = useEditorStore((s) => s.updateFrameworkTypographyGroup)
  const onDuplicateGroup = useEditorStore((s) => s.duplicateFrameworkTypographyGroup)
  const onResetGroup = useEditorStore((s) => s.resetFrameworkTypographyGroup)
  const onDeleteGroup = useEditorStore((s) => s.deleteFrameworkTypographyGroup)
  const onUpsertManualSize = useEditorStore((s) => s.upsertFrameworkTypographyManualSize)
  const onSetClassGenerators = useEditorStore((s) => s.setFrameworkTypographyClassGenerators)
  const confirmFrameworkChange = useFrameworkChangeConfirm()

  const wrappedToggleDisabled = () =>
    confirmFrameworkChange({
      actionLabel: 'Disable typography framework',
      applyChange: (draft) => {
        const tg = draft.settings.framework?.typography
        if (tg) tg.isDisabled = !tg.isDisabled
      },
      commit: onToggleDisabled,
    })

  const wrappedDeleteGroup = (groupId: string) =>
    confirmFrameworkChange({
      actionLabel: groupActionLabel('Delete typography scale', groupId),
      applyChange: (draft) => {
        const tg = draft.settings.framework?.typography
        if (!tg) return
        tg.groups = (tg.groups ?? []).filter((g) => g.id !== groupId)
      },
      commit: () => onDeleteGroup(groupId),
    })

  const wrappedUpdateGroup = (
    groupId: string,
    patch: Parameters<typeof onUpdateGroup>[1],
  ) =>
    confirmFrameworkChange({
      actionLabel: groupActionLabel('Update typography scale', groupId),
      applyChange: (draft) => applyTypographyGroupPatchPreview(draft, groupId, patch),
      commit: () => onUpdateGroup(groupId, patch),
    })

  const wrappedSetClassGenerators = (next: FrameworkTypographyClassGenerator[]) =>
    confirmFrameworkChange({
      actionLabel: 'Update typography class generators',
      applyChange: (draft) => {
        const tg = draft.settings.framework?.typography
        if (tg) tg.classes = next
      },
      commit: () => onSetClassGenerators(next),
    })

  const adapter: ScaleAdapter<FrameworkTypographyGroup, FrameworkTypographyClassGenerator> = {
    title: 'Typography',
    panelId: 'typography',
    selectGroups: (state) => state.site?.settings.framework?.typography?.groups ?? EMPTY_GROUPS,
    selectClasses: (state) => state.site?.settings.framework?.typography?.classes ?? EMPTY_CLASSES,
    selectIsDisabled: (state) =>
      Boolean(state.site?.settings.framework?.typography?.isDisabled),
    ratioOptions: TYPE_RATIO_OPTIONS,
    classGeneratorProperties: TYPOGRAPHY_CSS_PROPERTIES,
    scalesSectionIcon: TextStartTIcon,
    baseSizeLabel: 'Font size',
    readBaseSize: (group, side) => Number(group[side].fontSize),
    patchBaseSize: (side, value) => ({
      [side]: { fontSize: value },
    }),
    renderPreview: (sizePx) => (
      <span
        className={styles.previewText}
        style={{ '--preview-text-size': `${Math.max(8, sizePx)}px` } as CSSProperties}
      >
        Aa
      </span>
    ),
    renderChart: ({ points }) => <TypographyScalePreview points={points} />,
    onToggleDisabled: wrappedToggleDisabled,
    onCreateGroup,
    onUpdateGroup: wrappedUpdateGroup,
    onDuplicateGroup,
    onResetGroup,
    onDeleteGroup: wrappedDeleteGroup,
    onUpsertManualSize,
    onSetClassGenerators: wrappedSetClassGenerators,
    extraSections: [
      {
        id: 'fonts',
        title: 'Fonts',
        // Show above Scales — fonts are loaded once per site and live above
        // the scale-tweaking workflow.
        position: 'top',
        defaultOpen: true,
        icon: TextColumsIcon,
        render: () => <FontsSection />,
      },
    ],
  }

  return <FrameworkScalePanel adapter={adapter} />
}
