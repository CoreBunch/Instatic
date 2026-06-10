/**
 * useSiteSummary — fetch site name + favicon for the admin shell without
 * dragging the editor store into the page graph.
 *
 * AdminPageLayout (the lightweight non-editor admin shell) needs these two
 * fields so the toolbar can render the site brand. The editor's full
 * `usePersistence` hook hydrates the whole SiteDocument into the editor
 * store — which is correct on canvas pages but ~165 KB of dead weight on
 * Plugins / Users / Account, where the rest of the editor surface never
 * mounts.
 *
 * This hook does the minimum:
 *   1. Fires a single `cmsAdapter.loadSite()` once per session, behind a
 *      module-level in-flight guard so concurrent admin pages share the
 *      same network request.
 *   2. Extracts `name` and `settings.faviconUrl` into the `adminUi` store,
 *      which the toolbar already subscribes to.
 *   3. Re-fires on the `cms-site-reload` window event so that name /
 *      favicon edits made from one admin tab propagate to the toolbar.
 *
 * On the Site editor (`AdminCanvasLayout`), `usePersistence` writes the same
 * summary into `adminUi` so this hook ends up returning cached data after the
 * editor has hydrated once.
 */
import { useEffect } from 'react'
import { cmsAdapter } from '@core/persistence/cms'
import { useAdminUi } from './adminUi'
import { CMS_SITE_RELOAD_EVENT } from './adminEvents'

let initialFetchPromise: Promise<void> | null = null

async function fetchAndPublishSummary(): Promise<void> {
  try {
    const site = await cmsAdapter.loadSite('default')
    useAdminUi.getState().setSiteSummary({
      name: site?.name ?? null,
      faviconUrl: site?.settings?.faviconUrl ?? null,
    })
  } catch (err) {
    console.error('[useSiteSummary] failed to fetch site summary:', err)
  }
}

export function useSiteSummary(): void {
  useEffect(() => {
    // Share the single in-flight fetch across concurrent admin-shell mounts.
    if (initialFetchPromise === null) {
      initialFetchPromise = fetchAndPublishSummary()
    }

    function onReload() {
      // Discard the cached promise so the next mount triggers a fresh fetch.
      initialFetchPromise = fetchAndPublishSummary()
    }

    window.addEventListener(CMS_SITE_RELOAD_EVENT, onReload)
    return () => {
      window.removeEventListener(CMS_SITE_RELOAD_EVENT, onReload)
    }
  }, [])
}
