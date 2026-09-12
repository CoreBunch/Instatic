/**
 * Full-panel package page: hero, stat tiles, Readme / Versions / Deps /
 * Security, links, and the sticky install bar. Reached from a result, a
 * curated tile, an installed row, or a typed exact name; "Back" returns to
 * where the user was. An installed package keeps its remove control even
 * when the registry cannot describe it any more.
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { SkeletonRows } from '@ui/components/Skeleton'
import { ArrowLeftIcon } from 'pixel-art-icons/icons/arrow-left'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'
import { BookOpenSolidIcon } from 'pixel-art-icons/icons/book-open-solid'
import { FilesStack2SolidIcon } from 'pixel-art-icons/icons/files-stack-2-solid'
import { PlugSolidIcon } from 'pixel-art-icons/icons/plug-solid'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { formatBytes } from '@admin/lib/formatBytes'
import type { RegistryPackageDetails, RegistrySearchHit, RegistryVersionInfo } from '@core/registry'
import { formatCount, formatDate, timeAgo } from './format'
import { InstallControl } from './InstallControl'
import { PackageReadme } from './PackageReadme'
import { renderReadmeHtml } from './readmeHtml'
import {
  DownloadsSparkline,
  KeywordChips,
  MetaItem,
  Monogram,
  PackageBadges,
  PackageLinks,
  StatTile,
  StaticTile,
  StatusBadge,
  TileGrid,
  VersionPill,
} from './PackageTiles'
import { tintStyle } from './tint'
import type { InstalledDependencies } from './useInstalledDependencies'
import { usePackageAdvisories, usePackageDetails, usePackageDownloads, usePackageHit } from './useRegistryData'
import tileStyles from './PackageTiles.module.css'
import styles from './PackageDetailView.module.css'

type DetailTab = 'readme' | 'versions' | 'deps' | 'security'

/** One rule for every stat tile: a number renders, a pending read shows "…", anything else is unknown. */
function statValue(value: number | null | undefined, loading: boolean, format: (value: number) => string): string {
  if (typeof value === 'number') return format(value)
  return loading ? '…' : 'unknown'
}

interface PackageDetailViewProps {
  name: string
  /** The search hit the user came from, if any: spares a second registry lookup. */
  hit: RegistrySearchHit | null
  /** True only once the registry profile has loaded and says this is public npm. */
  publicNpm: boolean
  deps: InstalledDependencies
  onBack: () => void
}

export function PackageDetailView({ name, hit: knownHit, publicNpm, deps, onBack }: PackageDetailViewProps) {
  const details = usePackageDetails(name)
  const hit = usePackageHit(name, knownHit)
  const downloads = usePackageDownloads(name)
  const [tab, setTab] = useState<DetailTab>('readme')

  const data = details.data
  const latestInfo = data?.versions.find((info) => info.version === data.latest) ?? null
  const published = latestInfo?.date ?? data?.modified ?? null
  const maintainer = data?.maintainers[0] ?? hit.data?.publisher ?? null
  const weekly = downloads.data?.weekly ?? hit.data?.weeklyDownloads ?? null
  // Rendered once per README, not once per visit to the Readme tab.
  const readmeHtml = renderReadmeHtml(data?.readme ?? '')

  return (
    <div className={styles.detail} style={tintStyle(name)} data-testid={`package-detail-${name}`}>
      <div className={styles.bar}>
        <Button variant="ghost" size="xs" iconOnly onClick={onBack} aria-label="Back" tooltip="Back" data-testid="package-detail-back">
          <ArrowLeftIcon size={11} aria-hidden="true" />
        </Button>
        <span className={styles.barTitle}>{name}</span>
        {publicNpm && data && (
          <a
            className={styles.barLink}
            href={`https://www.npmjs.com/package/${name}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open on npmjs.com"
          >
            <ExternalLinkSolidIcon size={11} aria-hidden="true" />
          </a>
        )}
      </div>

      <div className={styles.scroll}>
        {details.loading && !data && (
          <div className={styles.pad}>
            <SkeletonRows count={8} rowHeight={18} ariaLabel="Loading package" />
          </div>
        )}
        {details.error && (
          <div className={styles.pad}>
            <StaticTile className={tileStyles.errorTile} role="alert">
              <span>{details.error}</span>
              <Button variant="secondary" size="xs" onClick={details.refresh}>Retry</Button>
            </StaticTile>
          </div>
        )}
        {data && (
          <>
            <div className={styles.hero}>
              <Monogram name={name} size="lg" />
              <div className={styles.heroText}>
                <h2 className={styles.heroName}>{data.name}</h2>
                <div className={styles.heroMeta}>
                  <VersionPill>v{data.latest}</VersionPill>
                  {data.license && <MetaItem icon={FileTextSolidIcon}>{data.license}</MetaItem>}
                  {maintainer && <MetaItem icon={UsersSolidIcon}>{maintainer}</MetaItem>}
                </div>
              </div>
            </div>

            {data.description && <p className={styles.description}>{data.description}</p>}
            <div className={styles.pad}>
              <PackageBadges info={latestInfo} hit={hit.data} />
            </div>
            <div className={styles.pad}>
              <KeywordChips keywords={data.keywords} />
            </div>

            <div className={styles.stats}>
              <TileGrid columns={2}>
                <StatTile label="Weekly downloads" value={statValue(weekly, downloads.loading || hit.loading, formatCount)}>
                  <DownloadsSparkline daily={downloads.data?.daily ?? null} />
                </StatTile>
                <StatTile label="Dependents" value={statValue(hit.data?.dependents, hit.loading, formatCount)} sub="packages rely on it" />
                <StatTile
                  label="Unpacked size"
                  value={statValue(latestInfo?.unpackedSize, false, formatBytes)}
                  sub={latestInfo?.fileCount ? `${latestInfo.fileCount} files` : undefined}
                />
                <StatTile label="Last publish" value={timeAgo(published)} sub={formatDate(published)} />
              </TileGrid>
            </div>

            <div className={styles.tabs}>
              <SegmentedControl
                size="xs"
                fullWidth
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'readme', label: 'Readme', icon: <BookOpenSolidIcon size={10} aria-hidden="true" /> },
                  { value: 'versions', label: 'Versions', icon: <FilesStack2SolidIcon size={10} aria-hidden="true" /> },
                  { value: 'deps', label: 'Deps', icon: <PlugSolidIcon size={10} aria-hidden="true" /> },
                  { value: 'security', label: 'Security', icon: <LockSolidIcon size={10} aria-hidden="true" /> },
                ]}
              />
            </div>
            <div className={styles.tabTile}>
              {tab === 'readme' && <PackageReadme html={readmeHtml} />}
              {tab === 'versions' && <VersionsList details={data} />}
              {tab === 'deps' && <DependencyList info={latestInfo} />}
              {tab === 'security' && <AdvisoryList name={name} version={data.latest} publicNpm={publicNpm} />}
            </div>

            <div className={styles.pad}>
              <PackageLinks npmName={publicNpm ? name : null} homepage={data.homepage} repository={data.repository} />
            </div>
          </>
        )}
      </div>

      {/* Once the read has settled the bar always shows: an installed package
          must stay removable, and a package the registry cannot describe must
          still be declarable. */}
      {!details.loading && (
        <div className={styles.installBar}>
          <InstallControl name={name} details={data} deps={deps} />
        </div>
      )}
    </div>
  )
}

function VersionsList({ details }: { details: RegistryPackageDetails }) {
  const [showAll, setShowAll] = useState(false)
  const tagByVersion = new Map<string, string>()
  for (const [tag, version] of Object.entries(details.distTags)) tagByVersion.set(version, tag)
  const limit = 12
  const rows = showAll ? details.versions : details.versions.slice(0, limit)
  return (
    <div className={styles.versionList}>
      {rows.map((info) => (
        <div key={info.version} className={styles.versionRow} data-deprecated={info.deprecated ? 'true' : undefined}>
          <span className={styles.mono}>{info.version}</span>
          {tagByVersion.has(info.version) && <StatusBadge tone="info">{tagByVersion.get(info.version)}</StatusBadge>}
          {info.deprecated && <StatusBadge tone="danger">deprecated</StatusBadge>}
          <span className={styles.versionMeta}>{info.unpackedSize === null ? '' : formatBytes(info.unpackedSize)}</span>
          <span className={styles.versionMeta}>{formatDate(info.date)}</span>
        </div>
      ))}
      {!showAll && details.versions.length > limit && (
        <Button variant="ghost" size="xs" onClick={() => setShowAll(true)}>
          Show all {details.versionCount} versions
        </Button>
      )}
      {showAll && details.versionCount > details.versions.length && (
        <span className={styles.versionNote}>Showing the newest {details.versions.length} of {details.versionCount} versions.</span>
      )}
    </div>
  )
}

function DependencyList({ info }: { info: RegistryVersionInfo | null }) {
  const groups: Array<[label: string, entries: Array<[string, string]>]> = [
    ['dependencies', Object.entries(info?.dependencies ?? {})],
    ['peerDependencies', Object.entries(info?.peerDependencies ?? {})],
  ].filter((group): group is [string, Array<[string, string]>] => group[1].length > 0)
  if (groups.length === 0) {
    return <p className={styles.note}>No dependencies. This package is self-contained.</p>
  }
  return (
    <div className={styles.depGroups}>
      {groups.map(([label, entries]) => (
        <div key={label}>
          <div className={styles.groupLabel}>{label} · {entries.length}</div>
          {entries.map(([name, range]) => (
            <div key={name} className={styles.depLine}>
              <span className={styles.mono}>{name}</span>
              <span className={styles.depRange}>{range}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function AdvisoryList({ name, version, publicNpm }: { name: string; version: string; publicNpm: boolean }) {
  const advisories = usePackageAdvisories(publicNpm ? name : null, version)
  if (!publicNpm) return <p className={styles.note}>Security advisories are only looked up for the public npm registry.</p>
  if (advisories.error) return <p className={styles.note}>{advisories.error}</p>
  if (advisories.loading || !advisories.data) return <p className={styles.note}>Checking OSV…</p>
  if (advisories.data.length === 0) {
    return (
      <div className={styles.secureNote}>
        <CheckIcon size={11} aria-hidden="true" />
        No known vulnerabilities for {name}@{version} (OSV).
      </div>
    )
  }
  return (
    <div className={styles.advisories}>
      {advisories.data.map((advisory) => (
        <div key={advisory.id} className={styles.advisory}>
          <span className={styles.advisoryHead}>
            <WarningDiamondSolidIcon size={11} aria-hidden="true" />
            <span className={styles.mono}>{advisory.id}</span>
            {advisory.severity && <StatusBadge tone="danger">{advisory.severity}</StatusBadge>}
          </span>
          <span className={styles.advisorySummary}>{advisory.summary}</span>
        </div>
      ))}
    </div>
  )
}
