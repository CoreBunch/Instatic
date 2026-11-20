import { editCornerRadii, radiusCorners, readAuthoredRadii } from '@site/property-controls/cornerRadii'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { useEditorStore } from '@site/store/store'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { LabeledControl } from './LayoutSection/LabeledControl'
import styles from './StyleRuleComposer.module.css'

const cornerLabels = { nw: 'Top left', ne: 'Top right', se: 'Bottom right', sw: 'Bottom left' } as const

export function RadiusRow({ current, stored, onChangeMany, onPreview, onClearPreview }: {
  stored: Record<string, unknown>
  current: Record<string, unknown>
  onPreview: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview: () => void
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
}) {
  const scope = useEditorStore((s) => s.radiusScope)
  const setScope = useEditorStore((s) => s.setRadiusScope)
  const tokens = useSpacingTokens()
  const shorthand = String(current.borderRadius ?? '')
  const values = readAuthoredRadii(current)
  const uniform = values.every((value) => value === values[0])
  const separate = scope === 'parts' || (scope === null && !uniform)

  return (
    <LabeledControl label="Radius" isSet={Boolean(shorthand || values.some(Boolean))}>
      <div className={styles.radiusFields}>
        <div className={separate ? styles.metricPair : undefined}>
          {(separate ? radiusCorners : radiusCorners.slice(0, 1)).map((corner, i) => (
            <div key={corner}>
              {separate && <span className={styles.cornerLabel}>{cornerLabels[corner]}</span>}
              <TokenAwareInput adjustable minimum={0} aria-label={separate ? `${cornerLabels[corner]} radius` : 'Radius'}
                tokens={tokens} value={values[i] || undefined} placeholder="0px"
                onPreview={(value) => onPreview(editCornerRadii(stored, value, separate ? corner : undefined))} onClearPreview={onClearPreview}
                onCommit={(value) => { if ((value ?? '') !== values[i]) onChangeMany(editCornerRadii(stored, value, separate ? corner : undefined)) }} />
            </div>
          ))}
        </div>
        <Button variant="secondary" size="sm" iconOnly pressed={!separate}
          aria-label={separate ? 'Link corners' : 'Edit corners separately'}
          tooltip={separate ? 'Link corners' : 'Edit corners separately'}
          onClick={() => { if (separate && !uniform) onChangeMany(editCornerRadii(stored, values[0] || '0px')); setScope(separate ? 'all' : 'parts') }}>
          <LinkIcon size={14} />
        </Button>
      </div>
    </LabeledControl>
  )
}
