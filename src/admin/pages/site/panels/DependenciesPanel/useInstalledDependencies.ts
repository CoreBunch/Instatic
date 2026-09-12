/**
 * Everything the Dependencies panel needs to know about the site's own
 * packages, read from the editor store: the manifest, the resolved lock,
 * per-package usage, runtime-script issues, and the resolve lifecycle.
 * Mutations go through the store's `setDependency` / `removeDependency`;
 * `useAutoResolveDependencies` (mounted by the editor body) turns them into
 * installs. Call it once per panel and pass the result down: the usage scan
 * walks every script and page.
 */
import type { SiteFile } from '@core/files/schemas'
import { readDeclaredDependency } from '@core/site-dependencies/manifest'
import { useEditorStore } from '@site/store/store'
import { getSiteModuleDependencyUsage, registry } from '@core/module-engine'
import { analyzeRuntimeScriptImports } from '@core/site-runtime'
import { canManageRuntimeDependencies } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { isDependencyLockInSync } from '@core/site-dependencies/lockStatus'
import {
  combineDependencyUsage,
  summarizeRuntimeDependencyIssues,
  type DependencyUsageSummary,
  type RuntimeDependencyIssue,
} from './runtimeIssues'

/** Stable empty list so the analysis input keeps its identity while the site is still hydrating. */
const NO_FILES: SiteFile[] = []

const MANAGE_DEPENDENCIES_BLOCKED = 'Requires the "Manage runtime dependencies" capability'

type DependencyResolveDisplay =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | { kind: 'resolved'; lockedCount: number }
  | { kind: 'error'; message: string }

/** The range written to package.json for a version picked in the registry UI. */
export function versionRange(version: string): string {
  const trimmed = version.trim()
  return trimmed === '' || trimmed === 'latest' ? '*' : `^${trimmed}`
}

export type InstalledDependencies = ReturnType<typeof useInstalledDependencies>

export function useInstalledDependencies() {
  const site = useEditorStore((state) => state.site)
  const packageJson = useEditorStore((state) => state.packageJson)
  const lockedPackages = useEditorStore((state) => state.siteRuntime.dependencyLock.packages)
  const setDependency = useEditorStore((state) => state.setDependency)
  const removeDependency = useEditorStore((state) => state.removeDependency)
  const resolveDependencyLock = useEditorStore((state) => state.resolveDependencyLock)
  const resolveStatus = useEditorStore((state) => state.dependencyResolveStatus)
  const resolveLockedCount = useEditorStore((state) => state.dependencyResolveLockedCount)
  const resolveError = useEditorStore((state) => state.dependencyResolveError)
  const user = useCurrentAdminUser()

  const analysis = analyzeRuntimeScriptImports(site ? site.files : NO_FILES, packageJson)
  const usage = combineDependencyUsage(getSiteModuleDependencyUsage(site, registry), analysis.usage)
  const issues: RuntimeDependencyIssue[] = summarizeRuntimeDependencyIssues(analysis.diagnostics)
  const lockInSync = isDependencyLockInSync(packageJson, lockedPackages)

  // A stale "N locked" from an earlier resolve is misleading once the lock
  // has fallen out of sync again; the auto-resolve hook re-fires and the
  // fresh result replaces it.
  const resolve: DependencyResolveDisplay =
    resolveStatus === 'resolving'
      ? { kind: 'resolving' }
      : resolveStatus === 'error'
        ? { kind: 'error', message: resolveError ?? 'Dependency resolution failed' }
        : resolveStatus === 'resolved' && lockInSync
          ? { kind: 'resolved', lockedCount: resolveLockedCount }
          : { kind: 'idle' }

  const canManage = canManageRuntimeDependencies(user)

  return {
    dependencies: packageJson.dependencies,
    devDependencies: packageJson.devDependencies,
    lockedPackages,
    issues,
    lockInSync,
    resolve,
    canManage,
    manageBlockedReason: canManage ? undefined : MANAGE_DEPENDENCIES_BLOCKED,
    declared: (name: string) => readDeclaredDependency(packageJson, name),
    isInstalled: (name: string) => readDeclaredDependency(packageJson, name) !== null,
    usageFor: (name: string): DependencyUsageSummary | undefined => usage.get(name),
    install: (name: string, version: string, dev = false) => setDependency(name, versionRange(version), dev),
    /** Keep the declared range as-is (runtime-issue actions, "move to runtime"). */
    declare: (name: string, range: string, dev = false) => setDependency(name, range, dev),
    remove: (name: string) => removeDependency(name),
    retryResolve: () => {
      resolveDependencyLock().catch(() => {
        // The store records the failure in `dependencyResolveError`.
      })
    },
  }
}
