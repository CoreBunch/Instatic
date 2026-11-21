/**
 * Whether the resolved `siteRuntime.dependencyLock.packages` still matches the
 * requested `packageJson.dependencies`, so the UI and the auto-resolve hook
 * can tell when a (re-)resolve is needed. Pure logic; the resolve flow is the
 * only writer of the lock.
 *
 * Lives beside the manifest rather than in the Dependencies panel: the
 * auto-resolve hook the editor mounts depends on it whether or not the panel
 * is open.
 */
import type { LockedSiteDependency } from '@core/site-runtime'
import type { SitePackageJson } from './manifest'

export function isDependencyLockInSync(
  packageJson: SitePackageJson,
  lockedPackages: Record<string, LockedSiteDependency>,
): boolean {
  const requested = Object.entries(packageJson.dependencies)
  // Nothing requested means nothing to resolve; leftover lock entries are
  // harmless until the next install rewrites the lock.
  if (requested.length === 0) return true
  for (const [name, range] of requested) {
    const locked = lockedPackages[name]
    if (!locked || locked.requested !== range) return false
  }
  return Object.keys(lockedPackages).every((name) => Object.hasOwn(packageJson.dependencies, name))
}
