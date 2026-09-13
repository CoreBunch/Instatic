/**
 * Registry reads for the Dependencies panel, all through the server proxy
 * (`@core/persistence` → `/admin/api/cms/registry/*`).
 *
 * Search is a paged accumulator (each "show more" fetches one page and
 * appends). Everything else is one `useAsyncResource` per request; the
 * proxy's `Cache-Control: private` lets the browser cache absorb repeats,
 * so re-mounting a view after a search or a package page costs no network.
 */
import { useEffect, useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  getCmsRegistryLatestVersion,
  getCmsRegistryPackage,
  getCmsRegistryPackageAdvisories,
  getCmsRegistryPackageDownloads,
  getCmsRegistryProfile,
  searchCmsRegistry,
} from '@core/persistence'
import {
  REGISTRY_MAX_SEARCH_FROM,
  REGISTRY_SEARCH_PAGE_SIZE,
  type RegistryAdvisory,
  type RegistryDownloads,
  type RegistryPackageDetails,
  type RegistryProfile,
  type RegistrySearchHit,
  type RegistrySearchSort,
} from '@core/registry'

/** Trailing-edge debounce, so search-as-you-type sends one request per pause. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

/**
 * Which registry the server is configured against. Every npm-only affordance
 * (curated packages, category search, npmjs.com links, OSV advisories) hangs
 * off it, so a failed load must not read as "private registry": the resource
 * keeps its error and the panel offers a retry instead of silently hiding
 * half of itself.
 */
export function useRegistryProfile() {
  return useAsyncResource<RegistryProfile>(
    (signal) => getCmsRegistryProfile({ signal }),
    [],
    { fallbackError: 'Could not read the registry configuration' },
  )
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface SearchResult {
  key: string
  hits: RegistrySearchHit[]
  total: number
  loadedPages: number
  /** Pages the user asked for; one more than `loadedPages` while "show more" is in flight. */
  wantedPages: number
  /** False once a page comes back short, which is the only reliable end-of-results signal. */
  moreAvailable: boolean
  error: string | null
}

const EMPTY_RESULT: SearchResult = {
  key: '',
  hits: [],
  total: 0,
  loadedPages: 0,
  wantedPages: 1,
  moreAvailable: false,
  error: null,
}

export function useRegistrySearch(query: string, sort: RegistrySearchSort) {
  const text = query.trim()
  const key = `${text} ${sort}`
  const [result, setResult] = useState<SearchResult>(EMPTY_RESULT)

  // Everything about the list, including how many pages are wanted, lives
  // under the query key: a new query starts at page one, and coming back to
  // an earlier query after paging it does too.
  const current = result.key === key ? result : null
  const pages = current?.wantedPages ?? 1

  useEffect(() => {
    if (!text) return
    const controller = new AbortController()
    let cancelled = false
    const pageIndex = pages - 1
    const from = pageIndex * REGISTRY_SEARCH_PAGE_SIZE
    searchCmsRegistry(
      { text, sort, from, size: REGISTRY_SEARCH_PAGE_SIZE, hideDeprecated: true },
      { signal: controller.signal },
    )
      .then((page) => {
        if (cancelled) return
        setResult((previous) => {
          const kept = previous.key === key ? previous.hits.slice(0, from) : []
          return {
            key,
            hits: [...kept, ...page.hits],
            total: page.total,
            loadedPages: pageIndex + 1,
            wantedPages: pageIndex + 1,
            // The registry's `total` over-counts (it is measured before the
            // proxy drops uninstallable names) and some registries stop
            // answering well before it. A short page is the real end.
            moreAvailable:
              page.returned >= REGISTRY_SEARCH_PAGE_SIZE && from + REGISTRY_SEARCH_PAGE_SIZE < REGISTRY_MAX_SEARCH_FROM,
            error: null,
          }
        })
      })
      .catch((err: unknown) => {
        if (cancelled || isAbortError(err)) return
        setResult((previous) => ({
          ...(previous.key === key ? previous : { ...EMPTY_RESULT, key }),
          error: getErrorMessage(err, 'Registry search failed'),
        }))
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [key, text, sort, pages])

  // Results from a previous query never leak under a new one: the list is
  // empty (and loading) until the current key has answered. Loading is
  // derived, so no state is written inside the effect.
  const loading = text !== '' && (current === null || (current.loadedPages < pages && current.error === null))
  return {
    hits: current?.hits ?? [],
    total: current?.total ?? 0,
    loading,
    error: current?.error ?? null,
    /** Stays true while the next page loads, so the button can show its own busy state. */
    hasMore: current !== null && current.error === null && current.moreAvailable,
    loadMore: () =>
      setResult((previous) => (previous.key === key ? { ...previous, wantedPages: previous.loadedPages + 1 } : previous)),
  }
}

// ---------------------------------------------------------------------------
// Per-package reads
// ---------------------------------------------------------------------------

export function usePackageDetails(name: string | null) {
  return useAsyncResource<RegistryPackageDetails | null>(
    (signal) => (name ? getCmsRegistryPackage(name, { signal }) : Promise.resolve(null)),
    [name],
    { fallbackError: 'Could not load the package' },
  )
}

/**
 * The search-index record for one exact package (dependents, score). Callers
 * that already hold the hit pass it through and skip the lookup.
 */
export function usePackageHit(name: string | null, preloaded: RegistrySearchHit | null = null) {
  const known = preloaded && preloaded.name === name ? preloaded : null
  return useAsyncResource<RegistrySearchHit | null>(
    async (signal) => {
      if (!name) return null
      if (known) return known
      const page = await searchCmsRegistry({ text: name, size: 10, hideDeprecated: false }, { signal })
      return page.hits.find((hit) => hit.name === name) ?? null
    },
    [name, known],
    { swallowErrors: true },
  )
}

export function usePackageDownloads(name: string | null) {
  return useAsyncResource<RegistryDownloads | null>(
    (signal) => (name ? getCmsRegistryPackageDownloads(name, { signal }) : Promise.resolve(null)),
    [name],
    { swallowErrors: true },
  )
}

export function usePackageAdvisories(name: string | null, version: string | null) {
  return useAsyncResource<RegistryAdvisory[] | null>(
    async (signal) => {
      if (!name || !version) return null
      return (await getCmsRegistryPackageAdvisories(name, version, { signal })).advisories
    },
    [name, version],
    { fallbackError: 'Could not load security advisories' },
  )
}

/** `null` skips the lookup entirely, for rows that could not display the answer. */
export function useLatestVersion(name: string | null) {
  return useAsyncResource<string | null>(
    async (signal) => (name ? (await getCmsRegistryLatestVersion(name, { signal })).version : null),
    [name],
    { swallowErrors: true },
  )
}
