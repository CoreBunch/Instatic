/**
 * sitePanelSlice — Dependency management state (Phase E+).
 *
 * Owns the in-memory `packageJson` manifest.
 * The SitePanel overlay UI was deleted in Task #434 (Guideline #410: 5-panel layout);
 * DependenciesPanel now owns all dependency UI through DepsSection.tsx.
 *
 * This slice owns dependency-adjacent editor state:
 *   - packageJson         in-memory package.json manifest
 *   - siteRuntime         runtime lock + script load settings
 *   - setDependency       add/update a dependency
 *   - removeDependency    remove from both dependency buckets
 *
 * All setters include no-op guards (Guideline #242).
 *
 * @see Guideline #341 — Zustand Store Slice Registry (addendum)
 * @see Guideline #242 — Zustand Object Setters Must Guard Against No-Op Mutations
 * @see Task #434 — Migration & SitePanel Cleanup
 * @see Task #441 — Post-#434 Orphan Sweep (panel-toggle fields removed)
 */

import type { EditorStoreSliceCreator } from '@site/store/types'
import type {
  RuntimePackageImportmap,
  SiteDependencyLock,
  SiteRuntimeConfig,
  SiteScriptRuntimeConfig,
  SiteStyleRuntimeConfig,
} from '@core/site-runtime/schemas'
import {
  clonePackageJson,
  DEFAULT_SITE_PACKAGE_JSON,
  type SitePackageJson,
} from '@core/site-dependencies/manifest'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import {
  cloneSiteRuntimeConfig,
  DEFAULT_SITE_RUNTIME,
  normalizeScriptRuntimeConfig,
  normalizeStyleRuntimeConfig,
  normalizeSiteRuntimeConfig,
} from '@core/site-runtime'
import { resolveCmsRuntimeDependencies } from '@core/persistence/cmsRuntime'
import { buildSiteHelpers } from './site/helpers'
import { getErrorMessage } from '@core/utils/errorMessage'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal package.json shape for the in-memory manifest.
 * Stores only the dependency maps relevant to DependenciesPanel.
 */
type PackageJson = SitePackageJson

/**
 * Lifecycle of the background dependency-lock resolution. Driven by the
 * auto-resolve hook (and the manual `resolveDependencyLock()` action),
 * surfaced by DepsSection so the user can see what's happening even when
 * the work was triggered without a click.
 */
type DependencyResolveStatus = 'idle' | 'resolving' | 'resolved' | 'error'

interface SitePanelSlice {
  /**
   * In-memory package.json manifest.
   * Tracks intended site deps; installing is a separate bridge concern.
   */
  packageJson: PackageJson

  /**
   * Top-level mirror of `site.runtime` for granular subscriptions in script and
   * dependency panels. The persisted source of truth remains SiteDocument.
   */
  siteRuntime: SiteRuntimeConfig

  /**
   * Transient status for the dependency-lock resolution. Not persisted —
   * lives only as long as the editor session.
   */
  dependencyResolveStatus: DependencyResolveStatus

  /**
   * Number of packages locked at the end of the last successful resolution.
   * Used by DepsSection to render `"N locked"` after a background resolve.
   */
  dependencyResolveLockedCount: number

  /**
   * Error message from the most recent failed resolution. Cleared at the
   * start of every new attempt.
   */
  dependencyResolveError: string | null

  // ── Actions ──────────────────────────────────────────────────────────────

  /**
   * Add or update a dependency in the in-memory manifest.
   * @param name    npm package name (must pass SAFE_PACKAGE_NAME before dispatch)
   * @param version semver string, e.g. "^18.2.0" or "*"
   * @param dev     true → devDependencies; false/undefined → dependencies
   */
  setDependency: (name: string, version: string, dev?: boolean) => void

  /**
   * Remove a package from both dependencies and devDependencies.
   */
  removeDependency: (name: string) => void

  /**
   * Replace the runtime config for a script file.
   */
  setScriptRuntimeConfig: (fileId: string, config: SiteScriptRuntimeConfig) => void

  /**
   * Patch the runtime config for a script file.
   */
  patchScriptRuntimeConfig: (fileId: string, patch: Partial<SiteScriptRuntimeConfig>) => void

  /**
   * Remove stored runtime settings for a script file.
   */
  removeScriptRuntimeConfig: (fileId: string) => void

  /**
   * Replace the runtime config for a stylesheet file.
   */
  setStyleRuntimeConfig: (fileId: string, config: SiteStyleRuntimeConfig) => void

  /**
   * Patch the runtime config for a stylesheet file.
   */
  patchStyleRuntimeConfig: (fileId: string, patch: Partial<SiteStyleRuntimeConfig>) => void

  /**
   * Remove stored runtime settings for a stylesheet file.
   */
  removeStyleRuntimeConfig: (fileId: string) => void

  /**
   * Replace the self-hosted dependency lock + the prebuilt importmap
   * returned alongside it. The server emits both from one call to
   * `/runtime/dependencies/resolve` so they reflect the same install.
   * Pass `null` for the importmap to clear a stale map.
   */
  setSiteDependencyLock: (
    lock: SiteDependencyLock,
    packageImportmap: RuntimePackageImportmap | null,
  ) => void

  /**
   * Resolve the current `packageJson.dependencies` into a new lock, persist
   * it through `setSiteDependencyLock`, and surface the result through the
   * `dependencyResolve*` fields. Safe to call from a debounced effect — a
   * second call while one is in flight short-circuits to a no-op so we
   * don't pile up concurrent npm fetches against esm.sh.
   */
  resolveDependencyLock: () => Promise<void>

}

// ---------------------------------------------------------------------------
// Slice factory
// ---------------------------------------------------------------------------

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends SitePanelSlice {}
}

export const createSitePanelSlice: EditorStoreSliceCreator<SitePanelSlice> = (set, get) => {
  const { mutateSiteState } = buildSiteHelpers(set, get)

  function commitPackageJson(nextPackageJson: PackageJson): void {
    if (!get().site) {
      set({ packageJson: nextPackageJson })
      return
    }
    mutateSiteState((state, site) => {
      state.packageJson = nextPackageJson
      site.packageJson = nextPackageJson
      return true
    })
  }

  function commitSiteRuntime(nextRuntime: SiteRuntimeConfig, markUnsavedWithoutSite = false): void {
    if (!get().site) {
      set({
        siteRuntime: nextRuntime,
        ...(markUnsavedWithoutSite ? { hasUnsavedChanges: true } : {}),
      })
      return
    }
    mutateSiteState((state, site) => {
      state.siteRuntime = nextRuntime
      site.runtime = nextRuntime
      return true
    })
  }

  return {
    packageJson: clonePackageJson(DEFAULT_SITE_PACKAGE_JSON),
    siteRuntime: cloneSiteRuntimeConfig(DEFAULT_SITE_RUNTIME),
    dependencyResolveStatus: 'idle',
    dependencyResolveLockedCount: 0,
    dependencyResolveError: null,

  setDependency: (name, version, dev = false) => {
    if (!isSafePackageName(name)) return
    const safeVersion = version.trim() || '*'
    const current = get().packageJson
    const bucket = dev ? 'devDependencies' : 'dependencies'
    const otherBucket = dev ? 'dependencies' : 'devDependencies'
    // No-op guard (Guideline #242): skip if value unchanged and no bucket move is needed.
    if (Object.is(current[bucket][name], safeVersion) && !(name in current[otherBucket])) return
    const nextBucket = { ...current[bucket], [name]: safeVersion }
    const nextOtherBucket = { ...current[otherBucket] }
    delete nextOtherBucket[name]
    commitPackageJson({
      ...current,
      [bucket]: nextBucket,
      [otherBucket]: nextOtherBucket,
    })
  },

  removeDependency: (name) => {
    const { dependencies, devDependencies } = get().packageJson
    // No-op guard: package not present in either bucket
    if (!(name in dependencies) && !(name in devDependencies)) return
    const deps = { ...get().packageJson.dependencies }
    const devDeps = { ...get().packageJson.devDependencies }
    delete deps[name]
    delete devDeps[name]
    commitPackageJson({ ...get().packageJson, dependencies: deps, devDependencies: devDeps })
  },

  setScriptRuntimeConfig: (fileId, config) => {
    const site = get().site
    if (!site?.files.some((file) => file.id === fileId && file.type === 'script')) return

    const currentRuntime = get().siteRuntime
    const nextConfig = normalizeScriptRuntimeConfig(config)
    const currentConfig = currentRuntime.scripts[fileId]
    if (JSON.stringify(currentConfig) === JSON.stringify(nextConfig)) return

    const nextRuntime = {
      ...currentRuntime,
      scripts: {
        ...currentRuntime.scripts,
        [fileId]: nextConfig,
      },
    }
    commitSiteRuntime(nextRuntime, true)
  },

  patchScriptRuntimeConfig: (fileId, patch) => {
    const current = get().siteRuntime.scripts[fileId] ?? normalizeScriptRuntimeConfig(undefined)
    get().setScriptRuntimeConfig(fileId, {
      ...current,
      ...patch,
    })
  },

  removeScriptRuntimeConfig: (fileId) => {
    const currentRuntime = get().siteRuntime
    if (!(fileId in currentRuntime.scripts)) return

    const scripts = { ...currentRuntime.scripts }
    delete scripts[fileId]
    commitSiteRuntime({ ...currentRuntime, scripts }, true)
  },

  setStyleRuntimeConfig: (fileId, config) => {
    const site = get().site
    if (!site?.files.some((file) => file.id === fileId && file.type === 'style')) return

    const currentRuntime = get().siteRuntime
    const nextConfig = normalizeStyleRuntimeConfig(config)
    const currentConfig = currentRuntime.styles[fileId]
    if (JSON.stringify(currentConfig) === JSON.stringify(nextConfig)) return

    const nextRuntime = {
      ...currentRuntime,
      styles: {
        ...currentRuntime.styles,
        [fileId]: nextConfig,
      },
    }
    commitSiteRuntime(nextRuntime, true)
  },

  patchStyleRuntimeConfig: (fileId, patch) => {
    const current = get().siteRuntime.styles[fileId] ?? normalizeStyleRuntimeConfig(undefined)
    get().setStyleRuntimeConfig(fileId, {
      ...current,
      ...patch,
    })
  },

  removeStyleRuntimeConfig: (fileId) => {
    const currentRuntime = get().siteRuntime
    if (!(fileId in currentRuntime.styles)) return

    const styles = { ...currentRuntime.styles }
    delete styles[fileId]
    commitSiteRuntime({ ...currentRuntime, styles }, true)
  },

  setSiteDependencyLock: (lock, packageImportmap) => {
    const normalized = normalizeSiteRuntimeConfig({
      dependencyLock: lock,
      packageImportmap,
    })
    const nextLock = normalized.dependencyLock
    const nextImportmap = normalized.packageImportmap
    const currentRuntime = get().siteRuntime
    const lockUnchanged = JSON.stringify(currentRuntime.dependencyLock) === JSON.stringify(nextLock)
    // `null` means "clear" — drop a stale map. Otherwise compare the
    // normalized importmaps to decide whether anything changed.
    const importmapUnchanged =
      JSON.stringify(currentRuntime.packageImportmap ?? null) === JSON.stringify(nextImportmap ?? null)
    if (lockUnchanged && importmapUnchanged) return

    const baseRuntime = { ...currentRuntime, dependencyLock: nextLock }
    const nextRuntime: SiteRuntimeConfig = nextImportmap
      ? { ...baseRuntime, packageImportmap: nextImportmap }
      : (() => {
        const stripped = { ...baseRuntime }
        delete stripped.packageImportmap
        return stripped
      })()
    commitSiteRuntime(nextRuntime)
  },

  resolveDependencyLock: async () => {
    // Concurrency guard — a second auto-resolve fired by a fresh edit
    // mid-resolution would race the network call and the `setSiteDependencyLock`
    // write. The trailing edit will re-trigger the auto-resolve hook
    // (lockStatus stays out-of-sync) and we'll pick it up then.
    if (get().dependencyResolveStatus === 'resolving') return

    set({ dependencyResolveStatus: 'resolving', dependencyResolveError: null })

    try {
      const result = await resolveCmsRuntimeDependencies(get().packageJson)
      get().setSiteDependencyLock(result.dependencyLock, result.packageImportmap ?? null)
      set({
        dependencyResolveStatus: 'resolved',
        dependencyResolveLockedCount: Object.keys(result.dependencyLock.packages).length,
        dependencyResolveError: null,
      })
    } catch (err) {
      const message = getErrorMessage(err, 'Dependency resolution failed')
      set({ dependencyResolveStatus: 'error', dependencyResolveError: message })
    }
  },

  }
}
