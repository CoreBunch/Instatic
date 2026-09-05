/**
 * useAutoResolveDependencies — keep the site's runtime state in lockstep
 * with the editor's draft `packageJson` + runtime cache contents.
 *
 * Triggers a resolve when any of these go out of sync:
 *
 *   • Lock is out of date — a dep was added, removed, or its requested
 *     range changed. Debounces so a burst of `setDependency` calls
 *     (e.g. inserting a module that declares peer deps) collapses into
 *     one resolution.
 *   • Importmap is missing while the lock is populated — happens after
 *     opening a site whose state was persisted before the importmap
 *     surface existed, or when the server skipped the install step on
 *     the previous resolve (network blip mid-flight). Without this the
 *     editor's iframe sandbox would render with an empty import map and
 *     plugins would see "TypeError: Failed to resolve module specifier".
 *
 * The resolution itself is a store action (`resolveDependencyLock`) so the
 * Dependencies panel (`useInstalledDependencies`) reads the same status the
 * auto-resolve produces and can offer a retry.
 * Failures surface through `dependencyResolveStatus = 'error'` but don't
 * throw — a network blip shouldn't crash the editor.
 *
 * Mounted from `AdminCanvasEditorBody` so the loop runs whenever the visual
 * editor is open, regardless of whether the Dependencies panel is visible.
 * Installing from the panel writes `packageJson` and relies on this hook to
 * turn that into a resolve; keep them mounted together.
 */
import { useEffect, useRef } from 'react'
import { useEditorStore } from '@site/store/store'
import { isDependencyLockInSync } from '@core/site-dependencies/lockStatus'

const AUTO_RESOLVE_DEBOUNCE_MS = 600

interface UseAutoResolveDependenciesOptions {
  /** Defaults to the production debounce; tests pass 0 to avoid real-time waits. */
  debounceMs?: number
}

export function useAutoResolveDependencies({
  debounceMs = AUTO_RESOLVE_DEBOUNCE_MS,
}: UseAutoResolveDependenciesOptions = {}): void {
  const packageJson = useEditorStore((s) => s.packageJson)
  const lockedPackages = useEditorStore((s) => s.siteRuntime.dependencyLock.packages)
  const packageImportmap = useEditorStore((s) => s.siteRuntime.packageImportmap)
  const resolveDependencyLock = useEditorStore((s) => s.resolveDependencyLock)
  const dependencyResolveStatus = useEditorStore((s) => s.dependencyResolveStatus)
  const site = useEditorStore((s) => s.site)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Skip while the site is hydrating — `packageJson` and `lockedPackages`
    // are seeded to their defaults before the document arrives, which would
    // otherwise fire one no-op resolve on mount.
    if (!site) return

    const lockInSync = isDependencyLockInSync(packageJson, lockedPackages)
    const lockHasPackages = Object.keys(lockedPackages).length > 0
    // Every locked package needs a root entry in the importmap — `name` →
    // its entry-file URL. Missing entries mean the iframe sandbox would
    // 404 the bare import, so we trigger a fresh resolve to rebuild the map.
    const importmapMissing = lockHasPackages && (
      !packageImportmap
      || Object.keys(lockedPackages).some((name) => !packageImportmap.imports[name])
    )
    if (lockInSync && !importmapMissing) return

    // Don't pile on top of an in-flight resolve — the action's own
    // concurrency guard short-circuits, but skipping the timer avoids the
    // setTimeout churn during a long-running resolution.
    if (dependencyResolveStatus === 'resolving') return

    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      // Swallow rejections — the action stores the error on the slice for
      // the Dependencies panel to display. A thrown promise here would surface as an
      // unhandled rejection in the console.
      resolveDependencyLock().catch(() => {})
    }, debounceMs)

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [site, packageJson, lockedPackages, packageImportmap, resolveDependencyLock, dependencyResolveStatus, debounceMs])
}
