/**
 * Dependencies panel body: one search box on top; home (installed, popular,
 * categories) while it is empty, registry results while typing, and a
 * full-panel package page once something is opened. Runtime-script issues
 * (missing or misdeclared packages) sit above the home and results views.
 *
 * A package can always be opened by its exact name, even when the search
 * index does not list it (just published, deprecated, or a private registry
 * without search): the results view offers an "Open package" tile for a
 * typed name, and Enter opens the typed name directly.
 */
import { useState, type KeyboardEvent } from 'react'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import type { RegistrySearchHit, RegistrySearchSort } from '@core/registry'
import { HomeView } from './HomeView'
import { ResultsView } from './ResultsView'
import { PackageDetailView } from './PackageDetailView'
import { useInstalledDependencies } from './useInstalledDependencies'
import { useDebouncedValue, useRegistryProfile, useRegistrySearch } from './useRegistryData'
import type { RuntimeDependencyIssue } from './runtimeIssues'
import styles from './RegistryPanel.module.css'

interface Selection {
  name: string
  /** The search hit the user came from, when there was one; saves a lookup on the package page. */
  hit: RegistrySearchHit | null
}

export function RegistryPanel() {
  const deps = useInstalledDependencies()
  const profile = useRegistryProfile()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<RegistrySearchSort>('relevance')
  const [selected, setSelected] = useState<Selection | null>(null)
  const debounced = useDebouncedValue(query, 250)
  const search = useRegistrySearch(debounced, sort)
  const typed = query.trim()
  const searching = debounced.trim().length > 0
  const publicNpm = profile.data?.publicNpm === true

  const open = (name: string, hit: RegistrySearchHit | null = null) => setSelected({ name, hit })

  if (selected) {
    return (
      <PackageDetailView name={selected.name} hit={selected.hit} publicNpm={publicNpm} deps={deps} onBack={() => setSelected(null)} />
    )
  }

  const exactName = isSafePackageName(typed) && !search.hits.some((hit) => hit.name === typed) ? typed : null

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setQuery('')
      return
    }
    if (event.key !== 'Enter') return
    // Enter acts on what was typed, never on a result set that may still
    // belong to the previous query.
    if (isSafePackageName(typed)) {
      open(typed, search.hits.find((hit) => hit.name === typed) ?? null)
    } else if (!search.loading && debounced.trim() === typed && search.hits[0]) {
      open(search.hits[0].name, search.hits[0])
    }
  }

  return (
    <div className={styles.root} data-testid="registry-panel">
      <div className={styles.searchHead}>
        <SearchBar
          value={query}
          onValueChange={setQuery}
          onKeyDown={onSearchKeyDown}
          placeholder="Search npm packages"
          aria-label="Search npm registry"
          data-testid="registry-search"
        />
        {!searching && (
          profile.error ? (
            <p className={styles.searchHint} role="alert">
              {profile.error}
              <Button variant="ghost" size="micro" onClick={profile.refresh}>Retry</Button>
            </p>
          ) : publicNpm || !profile.data ? (
            <p className={styles.searchHint}>
              3M+ packages. Try <em>three</em>, <em>gsap</em> or <em>keywords:animation</em>.
            </p>
          ) : (
            <p className={styles.searchHint}>
              Packages from <em>{profile.data.host}</em>. Download counts, advisories and npm links are public-registry only.
            </p>
          )
        )}
      </div>

      {deps.issues.length > 0 && (
        <RuntimeIssues
          issues={deps.issues}
          canManage={deps.canManage}
          blockedReason={deps.manageBlockedReason}
          onAdd={(name) => deps.declare(name, '*', false)}
          onMove={(name) => deps.declare(name, deps.declared(name)?.range ?? '*', false)}
        />
      )}

      {searching ? (
        <ResultsView
          query={debounced}
          hits={search.hits}
          total={search.total}
          loading={search.loading}
          error={search.error}
          hasMore={search.hasMore}
          onLoadMore={search.loadMore}
          sort={sort}
          onSort={setSort}
          exactName={exactName}
          isInstalled={deps.isInstalled}
          onOpen={open}
        />
      ) : (
        <HomeView deps={deps} publicNpm={publicNpm} onOpen={open} onSearch={setQuery} />
      )}
    </div>
  )
}

interface RuntimeIssuesProps {
  issues: RuntimeDependencyIssue[]
  canManage: boolean
  blockedReason?: string
  onAdd: (name: string) => void
  onMove: (name: string) => void
}

function RuntimeIssues({ issues, canManage, blockedReason, onAdd, onMove }: RuntimeIssuesProps) {
  return (
    <div className={styles.issues} role="group" aria-label="Runtime dependency issues">
      {issues.map((issue) => (
        <div key={`${issue.code}:${issue.packageName}`} className={styles.issue}>
          <span className={styles.issueText}>
            <span className={styles.issuePackage}>{issue.packageName}</span>
            <span>{issue.message}</span>
          </span>
          {issue.action && (
            <Button
              variant="secondary"
              size="xs"
              disabled={!canManage}
              tooltip={blockedReason}
              onClick={() => (issue.action === 'add' ? onAdd(issue.packageName) : onMove(issue.packageName))}
            >
              {issue.action === 'add' ? 'Add' : 'Move'}
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}
