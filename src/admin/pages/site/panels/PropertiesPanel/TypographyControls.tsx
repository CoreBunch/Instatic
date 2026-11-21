import type { CSSPropertyBag } from '@core/page-tree'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { NumericStyleInput } from '@site/property-controls/NumericStyleInput'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useTypographyTokens } from '@site/property-controls/tokenUtils'
import { TextAlignLeftIcon } from 'pixel-art-icons/icons/text-align-left'
import { TextAlignRightIcon } from 'pixel-art-icons/icons/text-align-right'
import { TextAlignCenterIcon } from 'pixel-art-icons/icons/text-align-center'
import { TextAlignJustifyIcon } from 'pixel-art-icons/icons/text-align-justify'
import { LabeledControl } from './LayoutSection/LabeledControl'
import { hasStyleValue } from './styleValueUtils'
import styles from './StyleRuleComposer.module.css'

interface MetricsProps {
  stored: Record<string, unknown>
  current: Record<string, unknown>
  onChange: (prop: keyof CSSPropertyBag, value: string | undefined) => void
  onPreview: (prop: keyof CSSPropertyBag, value: string | undefined) => void
  onClearPreview: () => void
}

export function TypographyMetrics({ stored, current, onChange, onPreview, onClearPreview }: MetricsProps) {
  const tokens = useTypographyTokens()
  return (
    <LabeledControl label="Size" isSet={hasStyleValue(stored.fontSize) || hasStyleValue(stored.lineHeight)}>
      <div className={styles.metricPair}>
        <div data-testid="css-property-row-fontSize">
          <TokenAwareInput adjustable minimum={0} aria-label="Font size" value={stored.fontSize == null ? undefined : String(stored.fontSize)}
            placeholder={String(current.fontSize ?? '16px')} tokens={tokens}
            onCommit={(value) => onChange('fontSize', value)}
            onPreview={(value) => onPreview('fontSize', value)} onClearPreview={onClearPreview} />
        </div>
        <div data-testid="css-property-row-lineHeight">
          <NumericStyleInput onScrubPreview={(value) => onPreview('lineHeight', value)} onClearPreview={onClearPreview}
            increment={0.1} min={0} onAdjust={(value) => onChange('lineHeight', value)} fieldSize="sm" aria-label="Line height" unit="lh"
            value={String(stored.lineHeight ?? '')} placeholder={String(current.lineHeight ?? '1.5')}
            onChange={(event) => onChange('lineHeight', event.target.value || undefined)} />
        </div>
      </div>
    </LabeledControl>
  )
}

const alignmentOptions = [
  { value: 'left', icon: <TextAlignLeftIcon size={14} />, ariaLabel: 'Align text left' },
  { value: 'center', icon: <TextAlignCenterIcon size={14} />, ariaLabel: 'Center text' },
  { value: 'right', icon: <TextAlignRightIcon size={14} />, ariaLabel: 'Align text right' },
  { value: 'justify', icon: <TextAlignJustifyIcon size={14} />, ariaLabel: 'Justify text' },
]

export function TextAlignment({ stored, current, onChange, onClear }: {
  stored: unknown
  current: unknown
  onChange: (value: string) => void
  onClear: () => void
}) {
  const value = typeof current === 'string' ? current : undefined
  const options = value && !alignmentOptions.some((option) => option.value === value)
    ? [...alignmentOptions, { value, label: value, ariaLabel: value }]
    : alignmentOptions
  return (
    <LabeledControl label="Align" isSet={hasStyleValue(stored)}>
      <SegmentedControl fullWidth aria-label="Text alignment" options={options}
        value={value} onChange={onChange} onClear={onClear} />
    </LabeledControl>
  )
}
