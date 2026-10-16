/**
 * Presentational building blocks for the Dependencies panel.
 *
 * Tiles follow the borderless card pattern from `docs/design.md`
 * ("Cards are tiles, not boxes"): `--bg-surface-2` tiles on the sidebar's
 * `--bg-surface`, a 1px grid gap, `--card-radius`, hover lifts the tone.
 * `--tint` carries a package's identity accent (`railAccent(name)`) into the
 * monogram and sparkline; state colour is reserved for installed / update /
 * security signals.
 *
 * `Tile` renders through the `Button` primitive (ghost, start-aligned) with
 * the tile chrome layered on by class, the same way the module inserter's
 * tile items do. The row layout classes (`row`, `rowMain`, `rowTitle`,
 * `rowSub`, `chevron`) are shared by every one-line tile in the panel.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { Button, type ButtonProps } from '@ui/components/Button'
import { Tooltip } from '@ui/components/Tooltip'
import { TagPill, type TagPillTone } from '@ui/components/TagPill'
import { cn } from '@ui/cn'
import type { RailAccent } from '@ui/railAccent'
import { Sparkline } from '@ui/components/charts'
import type { IconComponent } from 'pixel-art-icons/types'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import type { RegistrySearchHit, RegistryVersionInfo } from '@core/registry'
import { accentStyle, tintStyle } from './tint'
import styles from './PackageTiles.module.css'

const SPARKLINE_HEIGHT = 26
const KEYWORD_LIMIT = 8

function monogram(name: string): string {
  return name.replace(/^@[^/]+\//, '').slice(0, 2).toUpperCase()
}

export function Monogram({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  return (
    <span className={cn(styles.monogram, size === 'lg' && styles.monogramLg)} aria-hidden="true">
      {monogram(name)}
    </span>
  )
}

interface SectionTitleProps {
  icon: IconComponent
  accent: RailAccent
  count?: number
  trailing?: ReactNode
  children: string
}

export function SectionTitle({ icon: Icon, accent, count, trailing, children }: SectionTitleProps) {
  return (
    <div className={styles.sectionTitle} style={accentStyle(accent)}>
      <Icon size={11} color="var(--tint)" aria-hidden="true" />
      <span>{children}</span>
      {count !== undefined && <span className={styles.sectionCount}>{count}</span>}
      {trailing && <span className={styles.sectionTrailing}>{trailing}</span>}
    </div>
  )
}

export function TileGrid({ columns = 1, children }: { columns?: 1 | 2; children: ReactNode }) {
  return <div className={cn(styles.tiles, columns === 2 && styles.tiles2)}>{children}</div>
}

interface TileProps extends Omit<ButtonProps, 'variant' | 'size' | 'align'> {
  /** Identity for the accent tint (usually the package name). */
  tint?: string
}

export function Tile({ tint, className, style, children, ...rest }: TileProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      align="start"
      className={cn(styles.tile, className)}
      style={tint ? { ...tintStyle(tint), ...style } : style}
      {...rest}
    >
      {children}
    </Button>
  )
}

export function StaticTile({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn(styles.tile, styles.tileStatic, className)} {...rest}>
      {children}
    </div>
  )
}

export function MetaItem({ icon: Icon, children, className }: { icon?: IconComponent; children: ReactNode; className?: string }) {
  return (
    <span className={cn(styles.metaItem, className)}>
      {Icon && <Icon size={9} aria-hidden="true" />}
      {children}
    </span>
  )
}

/**
 * A version number. `TagPill` in monospace: muted by default, success-toned
 * once the package is locked.
 */
export function VersionPill({ label, locked = false, testId, ...rest }: {
  label: string
  locked?: boolean
  testId?: string
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    // The wrapper is what `Tooltip` clones: `TagPill` takes named props, not
    // arbitrary DOM handlers.
    <span className={styles.pillSlot} {...rest}>
      <TagPill label={label} size="xs" monospace muted={!locked} tone={locked ? 'success' : undefined} testId={testId} />
    </span>
  )
}

/**
 * A compatibility or health signal on a package. State tones carry meaning
 * (`ESM` good, `main only` caution, `no entry` / `deprecated` / `insecure`
 * bad); anything factual keeps the categorical accent `TagPill` derives from
 * its own label.
 */
export function StatusBadge({ label, tone, hint }: { label: string; tone?: TagPillTone; hint?: string }) {
  const badge = (
    <span className={styles.pillSlot}>
      <TagPill label={label} size="xs" tone={tone} />
    </span>
  )
  return hint ? <Tooltip content={hint}>{badge}</Tooltip> : badge
}

export function PackageBadges({ info, hit }: { info: RegistryVersionInfo | null; hit: RegistrySearchHit | null }) {
  const entry = info?.esmEntry
  return (
    <span className={styles.badges}>
      {info?.hasTypes && <StatusBadge label="TS" hint="Ships its own TypeScript types" />}
      {entry && entry.source !== 'main' && (
        <StatusBadge label="ESM" tone="success" hint={`ESM entry from "${entry.source}": ${entry.path}`} />
      )}
      {entry?.source === 'main' && (
        <StatusBadge label="main only" tone="warning" hint={`Only a "main" entry (${entry.path}); it may be CommonJS`} />
      )}
      {info && !entry && (
        <StatusBadge label="no entry" tone="danger" hint="No resolvable entry: the site runtime cannot import this package" />
      )}
      {info?.deprecated && <StatusBadge label="deprecated" tone="danger" hint={info.deprecated} />}
      {hit?.insecure && <StatusBadge label="insecure" tone="danger" hint="Flagged insecure by the registry" />}
    </span>
  )
}

export function StatTile({ label, value, sub, children }: { label: string; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <StaticTile className={styles.statTile}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
      {sub && <span className={styles.statSub}>{sub}</span>}
      {children}
    </StaticTile>
  )
}

export function DownloadsSparkline({ daily }: { daily: number[] | null }) {
  if (!daily || daily.length < 2) return <div className={styles.sparkPlaceholder} />
  return (
    <div className={styles.spark}>
      <Sparkline data={daily} height={SPARKLINE_HEIGHT} tint="var(--tint)" ariaLabel="Downloads, last 30 days" />
    </div>
  )
}

/** Keywords take the categorical accent each label produces, like every other tag in the editor. */
export function KeywordChips({ keywords }: { keywords: string[] }) {
  if (keywords.length === 0) return null
  return (
    <div className={styles.keywords}>
      {keywords.slice(0, KEYWORD_LIMIT).map((keyword) => (
        <TagPill key={keyword} label={keyword} size="xs" muted />
      ))}
    </div>
  )
}

function ExternalLink({ href, icon: Icon, children }: { href: string; icon: IconComponent; children: ReactNode }) {
  return (
    <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">
      <Icon size={10} aria-hidden="true" />
      <span>{children}</span>
      <ExternalLinkSolidIcon size={8} aria-hidden="true" className={styles.linkExternal} />
    </a>
  )
}

/** `npmName` is null when the package lives on a private registry: no npmjs.com link then. */
export function PackageLinks({ npmName, homepage, repository }: { npmName: string | null; homepage: string | null; repository: string | null }) {
  if (!npmName && !homepage && !repository) return null
  return (
    <div className={styles.links}>
      {npmName && <ExternalLink href={`https://www.npmjs.com/package/${npmName}`} icon={PackageSolidIcon}>npm</ExternalLink>}
      {homepage && <ExternalLink href={homepage} icon={GlobeSolidIcon}>Homepage</ExternalLink>}
      {repository && <ExternalLink href={repository} icon={CodeIcon}>Repository</ExternalLink>}
    </div>
  )
}
