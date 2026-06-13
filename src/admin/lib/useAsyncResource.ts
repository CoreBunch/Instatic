/**
 * The one async-load primitive for admin screens.
 *
 * Runs `loader` on mount and whenever `deps` change, tracks loading/error,
 * discards responses from a superseded or unmounted load, and exposes a stable
 * `refresh()`. This replaces the hand-rolled
 * `useState`+`useEffect`+`let cancelled = false`+`try/catch/finally` boilerplate
 * that every workspace hook and dialog used to reimplement, each with its own
 * cancellation-flag spelling and error-message wording.
 *
 * The loader receives an `AbortSignal`; forward it to `apiRequest({ signal })`
 * to abort the in-flight request on unmount/refresh. Persistence helpers that
 * take no signal still work — the stale response is discarded by the
 * cancellation guard regardless.
 *
 * `deps` follows the same contract as a `useEffect` dependency array: list
 * everything the loader closes over. When those values change the loader
 * re-runs with the fresh closure; the (otherwise stale) `loader` reference is
 * therefore always the one matching the current `deps`.
 *
 * ## When to use this (and when not to)
 *
 * USE it for the single-resource shape — one logical load that fills
 * `{ data, loading, error }`, optionally re-run via `refresh()` after a
 * mutation, optionally seeding an edit form (render-time-seed from `data`,
 * see `PluginSettingsDialog`). This is the canonical pattern for admin
 * screens; reach for it first.
 *
 * Do NOT bend the following shapes onto it — they are deliberately different
 * and forcing them here would be worse, not more consistent:
 *
 *   - **Multi-fetch orchestrators / optimistic collections** — several
 *     independent loads with granular per-fetch flags, or a fetched list that
 *     is then locally mutated (optimistic add/edit/delete). Examples:
 *     `useContentWorkspace`, `useDataWorkspace`, `useMediaWorkspace`,
 *     `usePluginsWorkspace`, `useUsersPageData`, and the media-list pickers
 *     that own a mutable list via `useStandaloneMediaEditor`
 *     (`MediaLibraryControl`, `useContentMediaPicker`, `MediaWidget`).
 *   - **Module-level cached loads** that dedupe across mounts and publish into
 *     a store or shared cache (`useSiteSummary`, `BindingPickerPopover`).
 *   - **Event-driven / subscription / activation effects** that aren't a GET
 *     (`useInstalledEditorPlugins`, `AdminSectionNavigation`, `SpotlightRoot`).
 *   - **Non-fetch effects** — rAF loops (`BreakpointSelectionOverlay`),
 *     debounced builders (`useRuntimeScriptBuild`), dynamic module imports
 *     (`PluginPageRenderer`), boot orchestration with `flushSync` paint timing
 *     (`useAdminBoot`), preference-sync-with-debounced-save
 *     (`useDashboardLayout`), or a status fetch that seeds an action state
 *     machine (`PublishButton`).
 */
import { useCallback, useEffect, useEffectEvent, useState, type DependencyList } from 'react'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'

interface AsyncResource<T> {
  /** Most recent successfully-loaded value, or null before the first success. */
  data: T | null
  /** True while a load is in flight (including the initial mount load). */
  loading: boolean
  /** Human-readable message from the most recent failed load, else null. */
  error: string | null
  /** Re-run the loader. Identity is stable across renders. */
  refresh: () => void
}

interface UseAsyncResourceOptions {
  /** Message used when a thrown value is not an `Error`. Default: 'Something went wrong'. */
  fallbackError?: string
  /**
   * When true, a failed load leaves `data` and `error` untouched instead of
   * surfacing the message — for views (e.g. dashboard widgets) that prefer to
   * keep a skeleton over rendering an error state.
   */
  swallowErrors?: boolean
}

function dependencyListsEqual(a: DependencyList, b: DependencyList): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
}

export function useAsyncResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  options: UseAsyncResourceOptions = {},
): AsyncResource<T> {
  const { fallbackError = 'Something went wrong', swallowErrors = false } = options
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadCount, setReloadCount] = useState(0)
  const [dependencyTracker, setDependencyTracker] = useState(() => ({
    deps: [...deps],
    version: 0,
  }))
  let dependencyVersion = dependencyTracker.version

  if (!dependencyListsEqual(dependencyTracker.deps, deps)) {
    dependencyVersion = dependencyTracker.version + 1
    setDependencyTracker({ deps: [...deps], version: dependencyVersion })
  }

  // Exception #1 (react-hooks/exhaustive-deps): consumers routinely place
  // `refresh` in their own dependency arrays, so it needs a stable identity the
  // static lint can see; the compiler's runtime memoization is invisible there.
  const refresh = useCallback(() => setReloadCount((n) => n + 1), [])

  const runLoad = useEffectEvent(async (
    signal: AbortSignal,
    isCancelled: () => boolean,
  ) => {
    setLoading(true)
    setError(null)
    try {
      const result = await loader(signal)
      if (isCancelled()) return
      setData(result)
      setLoading(false)
    } catch (err) {
      if (isCancelled()) return
      if (isAbortError(err)) {
        setLoading(false)
        return
      }
      if (!swallowErrors) {
        setError(getErrorMessage(err, fallbackError))
      }
      setLoading(false)
    }
  })

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    // Keep setState calls out of the lexical effect body; react-hooks/set-state-in-effect
    // treats the async boundary as the intentional load callback.
    void (async () => runLoad(controller.signal, () => cancelled))()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [dependencyVersion, reloadCount])

  return { data, loading, error, refresh }
}
