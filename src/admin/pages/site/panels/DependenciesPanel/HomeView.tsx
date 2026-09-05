/**
 * Dependencies panel home (empty search): what the site has installed and,
 * on the public npm registry, a curated set of packages that matter for
 * sites plus category shortcuts (`curated.ts`). A private registry gets the
 * installed sections only: its packages are not the ones that list names.
 */
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { Tooltip } from '@ui/components/Tooltip'
import { cn } from '@ui/cn'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { SparklesSolidIcon } from 'pixel-art-icons/icons/sparkles-solid'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { ArrowUpIcon } from 'pixel-art-icons/icons/arrow-up'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { SearchSolidIcon } from 'pixel-art-icons/icons/search-solid'
import type { RegistrySearchHit } from '@core/registry'
import { CATEGORIES, CURATED_PACKAGES } from './curated'
import { formatDependencyUsage, type DependencyUsageSummary } from './runtimeIssues'
import type { InstalledDependencies } from './useInstalledDependencies'
import { useLatestVersion } from './useRegistryData'
import { Monogram, SectionTitle, StaticTile, Tile, TileGrid, VersionPill } from './PackageTiles'
import { accentStyle } from './tint'
import tileStyles from './PackageTiles.module.css'
import styles from './HomeView.module.css'

type OpenPackage = (name: string, hit: RegistrySearchHit | null) => void

interface HomeViewProps {
  deps: InstalledDependencies
  /** True only once the registry profile has loaded and says this is public npm. */
  publicNpm: boolean
  onOpen: OpenPackage
  onSearch: (query: string) => void
}

export function HomeView({ deps, publicNpm, onOpen, onSearch }: HomeViewProps) {
  const names = Object.keys(deps.dependencies).sort()
  const devNames = Object.keys(deps.devDependencies).sort()

  return (
    <div className={styles.home}>
      <section className={styles.section}>
        <SectionTitle icon={PackageSolidIcon} accent="mint" count={names.length} trailing={<ResolveStatus deps={deps} hasPackages={names.length > 0} />}>
          Installed
        </SectionTitle>
        <TileGrid>
          {names.length === 0 ? (
            <StaticTile className={tileStyles.emptyTile}>
              <EmptyState
                plain
                compact
                align="start"
                icon={<SearchSolidIcon size={14} aria-hidden="true" />}
                description={publicNpm
                  ? 'Nothing installed yet. Search above or start from a popular package.'
                  : 'Nothing installed yet. Search above or type an exact package name.'}
              />
            </StaticTile>
          ) : (
            names.map((name) => (
              <InstalledRow
                key={name}
                name={name}
                range={deps.dependencies[name]}
                locked={deps.lockedPackages[name]?.version}
                usage={deps.usageFor(name)}
                onOpen={onOpen}
              />
            ))
          )}
        </TileGrid>
      </section>

      {devNames.length > 0 && (
        <section className={styles.section}>
          <SectionTitle icon={CodeIcon} accent="lilac" count={devNames.length}>Dev dependencies</SectionTitle>
          <TileGrid>
            {devNames.map((name) => (
              <InstalledRow key={name} name={name} range={deps.devDependencies[name]} dev usage={deps.usageFor(name)} onOpen={onOpen} />
            ))}
          </TileGrid>
        </section>
      )}

      {publicNpm && (
        <>
          <section className={styles.section}>
            <SectionTitle icon={SparklesSolidIcon} accent="gold">Popular for sites</SectionTitle>
            <TileGrid columns={2}>
              {CURATED_PACKAGES.map((entry) => (
                <Tile
                  key={entry.name}
                  tint={entry.name}
                  className={tileStyles.card}
                  onClick={() => onOpen(entry.name, null)}
                  data-testid={`curated-${entry.name}`}
                >
                  <span className={tileStyles.cardHead}>
                    <Monogram name={entry.name} />
                    <span className={cn(tileStyles.rowTitle, styles.curatedName)}>{entry.name}</span>
                    {deps.isInstalled(entry.name) && <CheckIcon size={9} className={styles.installedIcon} aria-hidden="true" />}
                  </span>
                  <span className={tileStyles.cardDescription}>{entry.blurb}</span>
                </Tile>
              ))}
            </TileGrid>
          </section>

          <section className={styles.section}>
            <SectionTitle icon={Grid2x22SolidIcon} accent="lilac">Browse by category</SectionTitle>
            <TileGrid columns={2}>
              {CATEGORIES.map((category) => (
                <Tile key={category.label} className={styles.categoryTile} style={accentStyle(category.accent)} onClick={() => onSearch(category.query)}>
                  <span className={styles.categoryIcon}>
                    <category.icon size={12} color="var(--tint)" aria-hidden="true" />
                  </span>
                  <span className={styles.categoryLabel}>{category.label}</span>
                </Tile>
              ))}
            </TileGrid>
          </section>
        </>
      )}
    </div>
  )
}

function ResolveStatus({ deps, hasPackages }: { deps: InstalledDependencies; hasPackages: boolean }) {
  const { resolve, lockInSync, retryResolve } = deps
  if (resolve.kind === 'resolving') return <span className={styles.status}>Resolving…</span>
  if (resolve.kind === 'error') {
    return (
      <>
        <span className={styles.status} data-status="error" role="alert">{resolve.message}</span>
        <Button variant="primary" size="micro" onClick={retryResolve} disabled={!deps.canManage} tooltip={deps.manageBlockedReason}>
          Retry resolve
        </Button>
      </>
    )
  }
  if (resolve.kind === 'resolved') {
    return <span className={styles.status} data-status="resolved">{resolve.lockedCount} locked</span>
  }
  if (hasPackages && !lockInSync) {
    return (
      <Button variant="secondary" size="micro" onClick={retryResolve} disabled={!deps.canManage} tooltip={deps.manageBlockedReason}>
        Re-resolve
      </Button>
    )
  }
  return null
}

interface InstalledRowProps {
  name: string
  range: string
  locked?: string
  dev?: boolean
  usage?: DependencyUsageSummary
  onOpen: OpenPackage
}

function InstalledRow({ name, range, locked, dev = false, usage, onOpen }: InstalledRowProps) {
  // Only a locked runtime package can show an update; asking for a dev row's
  // latest version would be one proxied registry call per row, per mount, for
  // something the row can never render.
  const latest = useLatestVersion(locked === undefined ? null : name)
  const updateAvailable = latest.data !== null && locked !== undefined && latest.data !== locked
  return (
    <Tile tint={name} className={tileStyles.row} onClick={() => onOpen(name, null)} data-testid={`dep-row-${name}`}>
      <Monogram name={name} />
      <span className={tileStyles.rowMain}>
        <Tooltip content={name}>
          <span className={tileStyles.rowTitle}>{name}</span>
        </Tooltip>
        <span className={tileStyles.rowSub}>
          {range}
          {dev && ' · dev'}
        </span>
      </span>
      {usage && (
        <Tooltip content={`Required by ${formatDependencyUsage(usage)}`}>
          <span className={styles.usagePill}>in use</span>
        </Tooltip>
      )}
      {updateAvailable && (
        <Tooltip content={`Update available: ${latest.data}`}>
          <span className={styles.updateChip}>
            <ArrowUpIcon size={8} aria-hidden="true" />
            {latest.data}
          </span>
        </Tooltip>
      )}
      {locked ? (
        <Tooltip content={`Locked at ${locked}`}>
          <VersionPill tone="locked" testId={`dep-locked-${name}`}>{locked}</VersionPill>
        </Tooltip>
      ) : (
        !dev && <VersionPill>unresolved</VersionPill>
      )}
      <ChevronRightIcon size={10} className={tileStyles.chevron} aria-hidden="true" />
    </Tile>
  )
}
