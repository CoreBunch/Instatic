/**
 * Registry search results as package tiles, with sort, load-more, and an
 * "open by exact name" escape hatch for packages the index does not list.
 */
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { SkeletonRows } from '@ui/components/Skeleton'
import { TrendingUpIcon } from 'pixel-art-icons/icons/trending-up'
import { CalendarSolidIcon } from 'pixel-art-icons/icons/calendar-solid'
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { SearchSolidIcon } from 'pixel-art-icons/icons/search-solid'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { PlugSolidIcon } from 'pixel-art-icons/icons/plug-solid'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import type { RegistrySearchHit, RegistrySearchSort } from '@core/registry'
import { formatCount, timeAgo } from './format'
import { MetaItem, Monogram, StaticTile, Tile, TileGrid } from './PackageTiles'
import tileStyles from './PackageTiles.module.css'
import styles from './ResultsView.module.css'

interface ResultsViewProps {
  query: string
  hits: RegistrySearchHit[]
  total: number
  loading: boolean
  error: string | null
  hasMore: boolean
  onLoadMore: () => void
  sort: RegistrySearchSort
  onSort: (sort: RegistrySearchSort) => void
  /** A typed, valid package name that no listed hit matches: offered as a direct open. */
  exactName: string | null
  isInstalled: (name: string) => boolean
  onOpen: (name: string, hit: RegistrySearchHit | null) => void
}

export function ResultsView({ query, hits, total, loading, error, hasMore, onLoadMore, sort, onSort, exactName, isInstalled, onOpen }: ResultsViewProps) {
  const showEmpty = !loading && !error && hits.length === 0 && !exactName
  // A name the site runtime could never declare is dropped from the results
  // by the proxy, so "nothing found" would be misleading on its own.
  const unsupportedName = showEmpty && query.trim() !== '' && !isSafePackageName(query.trim())
  return (
    <div className={styles.results} data-testid="registry-results">
      <div className={styles.bar}>
        <span className={styles.count} aria-live="polite">
          {total > 0 ? (
            <>
              <strong>{formatCount(total)}</strong> packages
            </>
          ) : loading ? (
            'Searching…'
          ) : (
            'No packages found'
          )}
        </span>
        <SegmentedControl
          size="micro"
          value={sort}
          onChange={onSort}
          options={[
            { value: 'relevance', label: 'Match' },
            { value: 'popularity', label: 'Popular', icon: <TrendingUpIcon size={9} aria-hidden="true" /> },
            { value: 'maintenance', label: 'Updated', icon: <CalendarSolidIcon size={9} aria-hidden="true" /> },
          ]}
        />
      </div>
      <div className={styles.scroll}>
        {error && (
          <StaticTile className={tileStyles.errorTile} role="alert">
            <span>{error}</span>
          </StaticTile>
        )}
        <TileGrid>
          {exactName && (
            <Tile tint={exactName} className={tileStyles.row} onClick={() => onOpen(exactName, null)} data-testid={`registry-open-${exactName}`}>
              <Monogram name={exactName} />
              <span className={tileStyles.rowMain}>
                <span className={tileStyles.rowTitle}>Open <span className={styles.exactName}>{exactName}</span></span>
                <span className={styles.exactHint}>Not in the results? Open the package by its exact name.</span>
              </span>
              <PackageSolidIcon size={11} className={tileStyles.chevron} aria-hidden="true" />
            </Tile>
          )}
          {hits.map((hit) => (
            <ResultTile key={hit.name} hit={hit} installed={isInstalled(hit.name)} onOpen={onOpen} />
          ))}
          {showEmpty && (
            <StaticTile className={tileStyles.emptyTile}>
              <EmptyState
                plain
                compact
                align="start"
                icon={<SearchSolidIcon size={14} aria-hidden="true" />}
                description={unsupportedName
                  ? <>“{query}” is not a package name this site can install. Names are lowercase, with hyphens, dots and <em>@scope/</em> prefixes.</>
                  : <>Nothing matches “{query}”. Try a shorter name or a <em>keywords:</em> search.</>}
              />
            </StaticTile>
          )}
        </TileGrid>
        {loading && hits.length === 0 && !error && (
          <div className={styles.skeleton}>
            <SkeletonRows count={6} rowHeight={84} ariaLabel="Searching the registry" />
          </div>
        )}
        {hasMore && (
          <div className={styles.more}>
            <Button variant="secondary" size="xs" fullWidth onClick={onLoadMore} disabled={loading} busy={loading}>
              {loading ? 'Loading…' : 'Show more results'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function ResultTile({ hit, installed, onOpen }: { hit: RegistrySearchHit; installed: boolean; onOpen: (name: string, hit: RegistrySearchHit) => void }) {
  return (
    <Tile tint={hit.name} className={tileStyles.card} onClick={() => onOpen(hit.name, hit)} data-testid={`registry-result-${hit.name}`}>
      <span className={tileStyles.cardHead}>
        <Monogram name={hit.name} />
        <span className={styles.title}>
          <span className={tileStyles.rowTitle}>{hit.name}</span>
          <span className={styles.version}>v{hit.version}</span>
        </span>
        {installed ? (
          <span className={styles.installedMark}>
            <CheckIcon size={9} aria-hidden="true" />
            Installed
          </span>
        ) : (
          <ChevronRightIcon size={10} className={tileStyles.chevron} aria-hidden="true" />
        )}
      </span>
      <span className={tileStyles.cardDescription}>{hit.description || 'No description.'}</span>
      <span className={styles.meta}>
        <MetaItem icon={TrendingUpIcon}>
          {formatCount(hit.weeklyDownloads)}
          <span className={tileStyles.metaUnit}>/wk</span>
        </MetaItem>
        {hit.dependents > 0 && (
          <MetaItem icon={PlugSolidIcon}>
            {formatCount(hit.dependents)}
            <span className={tileStyles.metaUnit}>deps</span>
          </MetaItem>
        )}
        <MetaItem icon={CalendarSolidIcon}>{timeAgo(hit.date)}</MetaItem>
        {hit.publisher && <MetaItem icon={UsersSolidIcon} className={styles.publisher}>{hit.publisher}</MetaItem>}
      </span>
    </Tile>
  )
}
