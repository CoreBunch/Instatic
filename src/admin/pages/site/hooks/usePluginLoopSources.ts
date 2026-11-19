/**
 * Keeps the editor's list of plugin loop sources in line with the server's.
 *
 * Plugins register loop sources in the server process. This hook fetches
 * their descriptors and registers them as remote sources, so the Loop
 * module's picker, the field bindings and the canvas preview see them. It
 * fetches again whenever the list may have moved:
 *
 *   - the server says so: a `loop-sources` notice on the site socket, sent to
 *     every open editor when a plugin is enabled, disabled, upgraded or
 *     removed, or its worker restarts. The same notice fires when the socket
 *     (re)connects, because notices sent meanwhile are not replayed;
 *   - a preview was refused because nobody provides the source any more
 *     (`LOOP_SOURCES_STALE_EVENT`);
 *   - this tab changed the plugins itself (`CMS_PLUGINS_CHANGED_EVENT`);
 *   - the tab becomes visible again. A workspace without a site socket (the
 *     Content workspace) has only this and the mount to go on.
 *
 * It is separate from `useInstalledEditorPlugins` on purpose: that pass needs
 * access to the Plugins workspace, while using a plugin's source on a page
 * needs only `site.read`. Without `site.read` the hook does nothing.
 */
import { useEffect } from 'react'
import { replaceRemoteLoopSources } from '@core/loops'
import { listCmsLoopSources } from '@core/persistence/cmsLoopSources'
import { CMS_PLUGINS_CHANGED_EVENT } from '@plugins/utils/pluginEvents'
import { refreshRemoteLoopPreviews, LOOP_SOURCES_STALE_EVENT } from '@site/canvas/remoteLoopPreviews'
import { subscribeSiteNotice } from '@site/collab/siteNotices'

export function usePluginLoopSources(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // Answers can arrive out of order; only the latest request may write.
    let latest = 0

    function refresh() {
      const request = ++latest
      listCmsLoopSources()
        .then((sources) => {
          if (cancelled || request !== latest) return
          replaceRemoteLoopSources(sources)
          // A source that changed hands or shape must not keep an old sample.
          refreshRemoteLoopPreviews()
        })
        .catch((err: unknown) => {
          // The editor stays usable with the sources it already has.
          if (!cancelled) {
            console.error('[usePluginLoopSources] Loading plugin loop sources failed:', err)
          }
        })
    }

    function refreshWhenVisible() {
      if (document.visibilityState === 'visible') refresh()
    }

    refresh()
    const unsubscribeNotice = subscribeSiteNotice('loop-sources', refresh)
    window.addEventListener(CMS_PLUGINS_CHANGED_EVENT, refresh)
    window.addEventListener(LOOP_SOURCES_STALE_EVENT, refresh)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      cancelled = true
      unsubscribeNotice()
      window.removeEventListener(CMS_PLUGINS_CHANGED_EVENT, refresh)
      window.removeEventListener(LOOP_SOURCES_STALE_EVENT, refresh)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [enabled])
}
