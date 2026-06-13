/**
 * SiteDocument lifecycle actions: createSite, loadSite, clearSite, updateSiteName.
 */

import { findHomePage, reconcileSiteExplorerInPlace, reindexNodeParents } from '@core/page-tree'
import type { SiteDocument } from '@core/page-tree'
import { renderCache } from '@site/canvas/renderCache'
import {
  clonePackageJson,
  DEFAULT_SITE_PACKAGE_JSON,
} from '@core/site-dependencies/manifest'
import {
  cloneSiteRuntimeConfig,
  DEFAULT_SITE_RUNTIME,
} from '@core/site-runtime'
import { clearCanvasSelectionDraft } from '../selectionSlice'
import { createDefaultSiteDocument } from './defaults'
import { emptyDirtyMarks } from './dirtyTracking'
import { reconcileFrameworkClasses } from './framework/reconcile'
import type { SiteSlice, SiteSliceHelpers } from './types'

type LifecycleActions = Pick<
  SiteSlice,
  'createSite' | 'loadSite' | 'clearSite' | 'updateSiteName'
>

/**
 * Derive the `parentId` index for every page tree and Visual Component tree in
 * a site about to be hydrated into the store. Sites reach `loadSite` already
 * validated (the persistence layer reindexes on parse) OR hand-assembled (tests,
 * `createDefaultSiteDocument`); reindexing here is idempotent and guarantees the
 * O(1) `getParent` pointer is consistent before any mutation runs.
 */
function reindexSiteTreeParents(site: SiteDocument): void {
  for (const page of site.pages) reindexNodeParents(page.nodes)
  for (const vc of site.visualComponents ?? []) reindexNodeParents(vc.tree.nodes)
  for (const layout of site.layouts ?? []) reindexNodeParents(layout.nodes)
}

export function createLifecycleActions({
  set,
  mutateSite,
}: SiteSliceHelpers): LifecycleActions {
  return {
    createSite: (name) => {
      const site = createDefaultSiteDocument(name)
      reconcileSiteExplorerInPlace(site)
      reindexSiteTreeParents(site)
      const siteRuntime = cloneSiteRuntimeConfig(site.runtime)
      set((state) => {
        state.site = { ...site, runtime: siteRuntime }
        state.packageJson = clonePackageJson(site.packageJson)
        state.siteRuntime = siteRuntime
        // Default to the home page (slug `index`) so the editor opens on `/`
        // rather than whatever happens to be first in the array.
        state.activePageId = (findHomePage(site.pages) ?? site.pages[0]).id
        // Reset activeDocument — any previously-open VC reference belongs to
        // the prior site and would cause `mutateActiveTree` to silently no-op
        // (early-return) when the VC id is not present in the new site.
        state.activeDocument = null
        state._historyPast = []
        state._historyFuture = []
        state._historyCoalesceKey = null
        state.canUndo = false
        state.canRedo = false
        state.hasUnsavedChanges = false
        // A brand-new site has no stored rows at all — first save is full.
        state._dirtySave = { ...emptyDirtyMarks(), all: true }
      })
      return site
    },

    loadSite: (site) => {
      // Clear the render cache BEFORE store hydration so stale HTML from a previous
      // site cannot bleed into the canvas after switching projects.
      // (Guideline #307 / Architect message #1216 — critical integration note)
      renderCache.clear()
      reconcileFrameworkClasses(site)
      reconcileSiteExplorerInPlace(site)
      reindexSiteTreeParents(site)
      const packageJson = clonePackageJson(site.packageJson)
      const siteRuntime = cloneSiteRuntimeConfig(site.runtime)
      set((state) => {
        state.site = { ...site, packageJson, runtime: siteRuntime }
        state.packageJson = packageJson
        state.siteRuntime = siteRuntime
        // Default to the home page (slug `index`) so the editor opens on `/`
        // rather than whatever happens to be first in the array.
        state.activePageId = (findHomePage(site.pages) ?? site.pages[0])?.id ?? null
        // Reset activeDocument — see createSite for rationale.
        state.activeDocument = null
        state._historyPast = []
        state._historyFuture = []
        state._historyCoalesceKey = null
        state.canUndo = false
        state.canRedo = false
        state.hasUnsavedChanges = false
        state._dirtySave = emptyDirtyMarks()
      })
    },

    clearSite: () => {
      set((state) => {
        state.site = null
        state.packageJson = clonePackageJson(DEFAULT_SITE_PACKAGE_JSON)
        state.siteRuntime = cloneSiteRuntimeConfig(DEFAULT_SITE_RUNTIME)
        state.activePageId = null
        // Reset activeDocument — without a site there can be no active doc.
        state.activeDocument = null
        clearCanvasSelectionDraft(state)
        state._historyPast = []
        state._historyFuture = []
        state._historyCoalesceKey = null
        state.canUndo = false
        state.canRedo = false
        state._dirtySave = emptyDirtyMarks()
      })
    },

    updateSiteName: (name) => {
      mutateSite((p) => {
        if (p.name === name) return false
        p.name = name
        return true
      })
    },
  }
}
