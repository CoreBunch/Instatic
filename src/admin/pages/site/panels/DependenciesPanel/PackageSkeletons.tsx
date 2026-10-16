/**
 * Loading states that mirror the thing they stand in for.
 *
 * Both reuse the real tile classes rather than redrawing the chrome, so the
 * radius, padding and grid gap can never drift from the loaded state: only
 * the text and the monogram become shimmer blocks.
 */
import { Skeleton } from '@ui/components/Skeleton'
import { cn } from '@ui/cn'
import { TileGrid } from './PackageTiles'
import tileStyles from './PackageTiles.module.css'
import resultStyles from './ResultsView.module.css'
import styles from './PackageSkeletons.module.css'

/** Name widths vary per row so a loading list does not read as a striped block. */
const NAME_WIDTHS = ['58%', '42%', '70%', '50%', '64%', '46%']
const DESCRIPTION_WIDTHS = ['92%', '74%', '86%', '68%', '90%', '78%']

function ResultSkeleton({ index }: { index: number }) {
  return (
    <div className={cn(tileStyles.tile, tileStyles.tileStatic, tileStyles.card)}>
      <span className={tileStyles.cardHead}>
        {/* Same 26px square as `Monogram`. */}
        <Skeleton width={26} height={26} radius="var(--radius)" />
        <span className={resultStyles.title}>
          <Skeleton width={NAME_WIDTHS[index % NAME_WIDTHS.length]} height={11} />
          <Skeleton width={30} height={9} />
        </span>
      </span>
      <span className={styles.lines}>
        <Skeleton width={DESCRIPTION_WIDTHS[index % DESCRIPTION_WIDTHS.length]} height={9} />
        <Skeleton width="55%" height={9} />
      </span>
      <span className={resultStyles.meta}>
        <Skeleton width={52} height={8} />
        <Skeleton width={40} height={8} />
        <Skeleton width={58} height={8} />
      </span>
    </div>
  )
}

/** Placeholder result tiles, shaped like the ones that replace them. */
export function ResultsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label="Searching the registry">
      <TileGrid>
        {Array.from({ length: count }, (_, index) => (
          <ResultSkeleton key={`result-skeleton-${index}`} index={index} />
        ))}
      </TileGrid>
    </div>
  )
}

/** Placeholder package page: hero, badges, stat tiles, body. */
export function PackageDetailSkeleton() {
  return (
    <div className={styles.detail} role="status" aria-busy="true" aria-label="Loading package">
      <div className={styles.hero}>
        {/* Same 40px square as `Monogram size="lg"`. */}
        <Skeleton width={40} height={40} radius="var(--radius)" />
        <span className={styles.lines}>
          <Skeleton width="46%" height={18} />
          <span className={styles.inline}>
            <Skeleton width={54} height={11} radius="var(--radius-sm)" />
            <Skeleton width={38} height={10} />
            <Skeleton width={62} height={10} />
          </span>
        </span>
      </div>

      <span className={styles.lines}>
        <Skeleton width="94%" height={9} />
        <Skeleton width="72%" height={9} />
      </span>

      <span className={styles.inline}>
        <Skeleton width={28} height={15} radius="var(--input-radius)" />
        <Skeleton width={36} height={15} radius="var(--input-radius)" />
      </span>

      <TileGrid columns={2}>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={`stat-skeleton-${index}`} className={cn(tileStyles.tile, tileStyles.tileStatic, styles.statTile)}>
            <Skeleton width="62%" height={8} />
            <Skeleton width="44%" height={17} />
            <Skeleton width="52%" height={8} />
          </div>
        ))}
      </TileGrid>
    </div>
  )
}
