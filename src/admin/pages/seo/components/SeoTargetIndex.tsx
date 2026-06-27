/**
 * SeoTargetIndex — the Meta tab's right column: navigation + audit context.
 *
 * Search, kind filters, a clickable issues line, the pinned Site defaults
 * card (globe icon), then targets grouped under "Pages · N" style section
 * headers. Rows are bare <button> list rows (§8.8 in
 * `button-primitive-usage.test.ts`) — two lines (title + route/descriptor)
 * with a tiered score pill on the right; the Button primitive's fixed
 * heights and nowrap cannot host this layout. Keyboard: ↑/↓ move the
 * selection, `/` focuses search.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { SearchBar } from '@ui/components/SearchBar'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Button } from '@ui/components/Button'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { seoScoreTier, type SeoReport } from '@core/seo'
import { cn } from '@ui/cn'
import type { SeoTarget } from '../lib/seoApi'
import type { IndexedSeoTarget } from '../lib/indexTargets'
import styles from './SeoTargetIndex.module.css'

type SeoTargetFilter = 'all' | 'pages' | 'posts' | 'templates' | 'issues'

const FILTER_OPTIONS: { value: SeoTargetFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pages', label: 'Pages' },
  { value: 'posts', label: 'Posts' },
  { value: 'templates', label: 'Templates' },
  { value: 'issues', label: 'Issues' },
]

interface TargetGroup {
  label: string
  items: IndexedSeoTarget[]
}

interface SeoTargetIndexProps {
  indexed: IndexedSeoTarget[]
  selectedId: string
  siteDefaultsId: string
  onSelect: (id: string) => void
}

export function SeoTargetIndex({
  indexed,
  selectedId,
  siteDefaultsId,
  onSelect,
}: SeoTargetIndexProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SeoTargetFilter>('all')
  const searchRef = useRef<HTMLInputElement>(null)

  const issueCount = indexed.filter((item) => item.report.issueCount > 0).length

  const normalizedQuery = query.trim().toLowerCase()
  const visible = indexed.filter(({ target, report }) => {
    if (filter === 'pages' && target.kind !== 'page') return false
    if (filter === 'posts' && target.kind !== 'post') return false
    if (filter === 'templates' && target.kind !== 'template') return false
    if (filter === 'issues' && report.issueCount === 0) return false
    if (normalizedQuery === '') return true
    return (
      target.title.toLowerCase().includes(normalizedQuery) ||
      (target.route ?? '').toLowerCase().includes(normalizedQuery)
    )
  })

  const groups: TargetGroup[] = [
    { label: 'Pages', items: visible.filter(({ target }) => target.kind === 'page') },
    { label: 'Templates', items: visible.filter(({ target }) => target.kind === 'template') },
    { label: 'Posts', items: visible.filter(({ target }) => target.kind === 'post') },
  ].filter((group) => group.items.length > 0)

  // Keyboard order: pinned site row first, then the grouped targets in
  // display order.
  const order: string[] = [siteDefaultsId, ...groups.flatMap((group) => group.items.map(({ target }) => target.id))]

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === '/') {
      event.preventDefault()
      searchRef.current?.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const currentIndex = order.indexOf(selectedId)
    const nextIndex = event.key === 'ArrowDown'
      ? Math.min(order.length - 1, currentIndex + 1)
      : Math.max(0, currentIndex - 1)
    const next = order[nextIndex]
    if (next !== undefined && next !== selectedId) onSelect(next)
  }

  return (
    <section className={styles.index} aria-label="SEO targets">
      <SearchBar
        ref={searchRef}
        value={query}
        onValueChange={setQuery}
        placeholder="Search targets…"
        aria-label="Search SEO targets"
        data-testid="seo-target-search"
      />

      <SegmentedControl
        value={filter}
        options={FILTER_OPTIONS}
        onChange={setFilter}
        size="xs"
        fullWidth
        aria-label="Filter targets"
        data-testid="seo-target-filter"
      />

      {issueCount > 0 && filter !== 'issues' && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className={styles.issuesLine}
          onClick={() => setFilter('issues')}
          data-testid="seo-issues-line"
        >
          <span className={styles.issuesDot} aria-hidden="true" />
          <span>{issueCount} {issueCount === 1 ? 'target needs' : 'targets need'} attention</span>
        </Button>
      )}

      <div
        className={styles.scroller}
        role="listbox"
        aria-label="SEO target list"
        tabIndex={0}
        onKeyDown={handleListKeyDown}
      >
        {/* §8.8 — pinned card + rows are bare <button> list rows. */}
        <button
          type="button"
          className={cn(styles.siteCard, selectedId === siteDefaultsId && styles.selected)}
          role="option"
          aria-selected={selectedId === siteDefaultsId}
          onClick={() => onSelect(siteDefaultsId)}
          data-testid="seo-target-site-defaults"
        >
          <span className={styles.siteCardIcon} aria-hidden="true">
            <GlobeSolidIcon size={14} />
          </span>
          <span className={styles.rowText}>
            <span className={styles.rowTitle}>Site defaults</span>
            <span className={styles.rowDescriptor}>Fallbacks for every target</span>
          </span>
          <ChevronRightIcon size={11} aria-hidden="true" className={styles.siteCardChevron} />
        </button>

        {groups.map((group) => (
          <div key={group.label} className={styles.group}>
            <h3 className={styles.groupLabel}>
              {group.label}
              <span className={styles.groupCount}>{group.items.length}</span>
            </h3>
            <div className={styles.groupList}>
              {group.items.map(({ target, report }) => (
                <TargetRow
                  key={target.id}
                  target={target}
                  report={report}
                  selected={selectedId === target.id}
                  onSelect={() => onSelect(target.id)}
                />
              ))}
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <p className={styles.empty} role="status">No targets match the current filter.</p>
        )}
      </div>
    </section>
  )
}

/** "Entry template · posts" — names the tables the template's patterns feed. */
function templateDescriptor(target: SeoTarget): string {
  const tables = target.templateTableSlugs ?? []
  return tables.length > 0 ? `Entry template · ${tables.join(', ')}` : 'Entry template'
}

function TargetRow({
  target,
  report,
  selected,
  onSelect,
}: {
  target: SeoTarget
  report: SeoReport
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={cn(styles.row, selected && styles.selected)}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      data-testid={`seo-target-${target.id}`}
    >
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{target.title}</span>
        {target.route !== null ? (
          <span className={styles.rowRoute}>{target.route}</span>
        ) : (
          <span className={styles.rowDescriptor}>{templateDescriptor(target)}</span>
        )}
      </span>
      <ScorePill report={report} />
    </button>
  )
}

/**
 * Tiered score pill: green ≥ 80, amber ≥ 50, red below. The title tooltip
 * names the open issues for hover discovery.
 */
function ScorePill({ report }: { report: SeoReport }) {
  const tier = seoScoreTier(report.score)
  const openIssues = report.checks.filter((check) => check.status !== 'pass')
  const summary = openIssues.length === 0
    ? 'No SEO issues'
    : `Needs work: ${openIssues.map((check) => check.label.toLowerCase()).join(', ')}`
  return (
    <span
      className={cn(styles.scorePill, styles[`scorePill_${tier}`])}
      title={summary}
      aria-label={`SEO score ${report.score}. ${summary}`}
    >
      {report.score}
    </span>
  )
}
