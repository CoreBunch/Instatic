import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { useEditorStore } from '@site/store/store'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { LabeledControl } from './LayoutSection/LabeledControl'
import styles from './StyleRuleComposer.module.css'

const corners = [
  ['borderTopLeftRadius', 'Top left'], ['borderTopRightRadius', 'Top right'],
  ['borderBottomRightRadius', 'Bottom right'], ['borderBottomLeftRadius', 'Bottom left'],
] as const

export function RadiusRow({ current, onChangeMany, onPreview, onClearPreview }: {
  current: Record<string, unknown>
  onPreview: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview: () => void
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
}) {
  const scope = useEditorStore((s) => s.radiusScope)
  const setScope = useEditorStore((s) => s.setRadiusScope)
  const tokens = useSpacingTokens()
  const shorthand = String(current.borderRadius ?? '')
  const css = document.createElement('div').style
  css.borderRadius = shorthand
  const values = corners.map(([key]) => String(current[key] ?? css[key] ?? ''))
  const uniform = values.every((value) => value === values[0])
  const separate = scope === 'parts' || (scope === null && !uniform)

  function radiusPatch(value: string | undefined, index?: number) {
    const patch = Object.fromEntries(corners.map(([key], i) =>
      [key, index === undefined || i === index ? value : values[i] || undefined]))
    return { ...patch, borderRadius: undefined }
  }
  return (
    <LabeledControl label="Radius" isSet={Boolean(shorthand || values.some(Boolean))}>
      <div className={styles.radiusFields}>
        <div className={separate ? styles.metricPair : undefined}>
          {(separate ? corners : corners.slice(0, 1)).map(([key, label], i) => (
            <div key={key}>
              {separate && <span className={styles.cornerLabel}>{label}</span>}
              <TokenAwareInput adjustable minimum={0} aria-label={separate ? `${label} radius` : 'Radius'}
                tokens={tokens} value={values[i] || undefined} placeholder="0px"
                onPreview={(value) => onPreview(radiusPatch(value, separate ? i : undefined))} onClearPreview={onClearPreview}
                onCommit={(value) => { if ((value ?? '') !== values[i]) onChangeMany(radiusPatch(value, separate ? i : undefined)) }} />
            </div>
          ))}
        </div>
        <Button variant="secondary" size="sm" iconOnly pressed={!separate}
          aria-label={separate ? 'Link corners' : 'Edit corners separately'}
          tooltip={separate ? 'Link corners' : 'Edit corners separately'}
          onClick={() => { if (separate && !uniform) onChangeMany(radiusPatch(values[0] || '0px')); setScope(separate ? 'all' : 'parts') }}>
          <LinkIcon size={14} />
        </Button>
      </div>
    </LabeledControl>
  )
}
