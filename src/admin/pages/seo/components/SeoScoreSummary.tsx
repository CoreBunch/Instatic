/**
 * SeoScoreSummary — the site-wide SEO score at the top of the Meta tab's
 * right sidebar: liquid-progress ring (tier-toned) beside a short
 * explanation of what the score aggregates.
 */
import { LiquidProgressRing } from '@ui/components/LiquidProgressRing'
import { aggregateSeoScore, seoScoreTier } from '@core/seo'
import type { IndexedSeoTarget } from '../lib/indexTargets'
import styles from './SeoScoreSummary.module.css'

const TIER_TONE = { good: 'mint', fair: 'amber', poor: 'danger' } as const

export function SeoScoreSummary({ indexed }: { indexed: IndexedSeoTarget[] }) {
  const total = indexed.length
  const score = aggregateSeoScore(indexed.map(({ report }) => report))

  return (
    <section className={styles.summary} aria-label="Site SEO score">
      <LiquidProgressRing
        value={score}
        total={100}
        size={104}
        tone={TIER_TONE[seoScoreTier(score)]}
        label={<span className={styles.value}>{score}</span>}
        ariaLabel={`Site SEO score: ${score} out of 100`}
      />
      <div className={styles.text}>
        <h3 className={styles.title}>Site SEO score</h3>
        <p className={styles.sub}>
          Average across {total} {total === 1 ? 'target' : 'targets'} — weighted checks on
          titles, descriptions, social cards, and indexability.
        </p>
      </div>
    </section>
  )
}
