/**
 * MetaLengthMeter — live character + approximate pixel-width meter for SEO
 * title/description fields, against Google's desktop truncation budgets
 * (~580px title / ~990px description).
 *
 * The track shows the IDEAL BAND (a faint green segment between the
 * too-short threshold and the budget tick); the fill is colored by zone —
 * neutral while too short, green only inside the band, amber approaching
 * the budget, red over it. So the bar reads "not enough yet" instead of
 * rewarding two characters with a green light.
 *
 * Inherited (placeholder) values render muted with an "Inherited" tag and
 * NO character count — the numbers belong to the user's own text only.
 */
import { cn } from '@ui/cn'
import {
  approxPixelWidth,
  meterZone,
  TITLE_PIXEL_BUDGET,
  TITLE_PIXEL_MIN,
  DESCRIPTION_PIXEL_BUDGET,
  DESCRIPTION_PIXEL_MIN,
  TITLE_CHAR_GUIDE,
  DESCRIPTION_CHAR_GUIDE,
} from '@core/seo'
import type { CSSProperties } from 'react'
import styles from './MetaLengthMeter.module.css'

interface MetaLengthMeterProps {
  text: string
  budget: 'title' | 'description'
  /** False when the meter measures an inherited placeholder, not user text. */
  explicit: boolean
}

const ZONE_HINT = {
  empty: 'empty',
  short: 'too short',
  ok: 'in the ideal band',
  amber: 'near the display budget',
  over: 'over the display budget',
} as const

export function MetaLengthMeter({ text, budget, explicit }: MetaLengthMeterProps) {
  const pixelBudget = budget === 'title' ? TITLE_PIXEL_BUDGET : DESCRIPTION_PIXEL_BUDGET
  const pixelMin = budget === 'title' ? TITLE_PIXEL_MIN : DESCRIPTION_PIXEL_MIN
  const charGuide = budget === 'title' ? TITLE_CHAR_GUIDE : DESCRIPTION_CHAR_GUIDE
  const width = approxPixelWidth(text)
  const zone = meterZone(width, pixelBudget, pixelMin)
  const fillPct = Math.min(100, Math.round((width / pixelBudget) * 100))
  const idealStartPct = Math.round((pixelMin / pixelBudget) * 100)

  return (
    <div
      className={cn(styles.meter, !explicit && styles.meterInherited)}
      role="status"
      aria-label={
        explicit
          ? `${budget === 'title' ? 'Title' : 'Description'} length: ${text.length} characters, ${ZONE_HINT[zone]}`
          : `${budget === 'title' ? 'Title' : 'Description'} ${text === '' ? 'has no value yet' : 'uses the inherited value'}`
      }
    >
      <span
        className={styles.track}
        style={{ '--seo-meter-fill': `${fillPct}%`, '--seo-meter-ideal-start': `${idealStartPct}%` } as CSSProperties}
      >
        <span className={styles.idealBand} aria-hidden="true" />
        <span className={cn(styles.fill, styles[`fill_${zone}`])} />
        <span className={styles.budgetTick} aria-hidden="true" />
      </span>
      {explicit ? (
        <span className={cn(styles.count, styles[`count_${zone}`])}>
          {text.length}/{charGuide}
        </span>
      ) : (
        <span className={styles.inheritedTag}>{text === '' ? 'Missing' : 'Inherited'}</span>
      )}
    </div>
  )
}
