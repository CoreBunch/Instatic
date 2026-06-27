/**
 * SeoScoreChip — compact live score readout for the editor header. Recolors
 * by tier (green ≥ 80, amber ≥ 50, red below) and updates on every
 * keystroke, so fixing a check visibly moves the number.
 */
import { seoScoreTier } from '@core/seo'
import { cn } from '@ui/cn'
import styles from './SeoScoreChip.module.css'

export function SeoScoreChip({ score }: { score: number }) {
  const tier = seoScoreTier(score)
  return (
    <span
      className={cn(styles.chip, styles[`chip_${tier}`])}
      role="status"
      aria-label={`SEO score: ${score} out of 100`}
      data-testid="seo-score-chip"
    >
      <span className={styles.value}>{score}</span>
      <span className={styles.caption}>SEO score</span>
    </span>
  )
}
