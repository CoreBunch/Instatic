/**
 * Keeps the editor's list of plugin loop sources in line with the server's.
 *
 * Plugins register loop sources in the server process. This hook fetches
 * their descriptors and registers them as remote sources, so the Loop
 * module's picker, the field bindings and the canvas preview see them. It
 * is mounted by the Site editor, the one workspace that draws loops on a
 * canvas. It fetches when the editor mounts and again when:
 *
 *   - this tab changed the plugins itself (`CMS_PLUGINS_CHANGED_EVENT`);
 *   - the tab becomes visible again;
 *   - a preview was refused because nobody provides the source any more, the
 *     author pressed Publish, or a publish warned of a loop without a source
 *     (`LOOP_SOURCES_STALE_EVENT`).
 *
 * Nothing is pushed from the server. A plugin enabled or disabled in another
 * tab, or by someone else, shows up here when the author comes back to this
 * tab or reloads it.
 *
 * It is separate from `useInstalledEditorPlugins` on purpose: that pass needs
 * access to the Plugins workspace, while using a plugin's source on a page
 * needs only `site.read`, which everyone who can open the Site editor holds.
 * It is mounted in the editor's lazily loaded body, so none of this is in
 * the route's first chunk.
 */
import { useEffect, useRef } from 'react'
import { replaceRemoteLoopSources } from '@core/loops'
import { listCmsLoopSources } from '@core/persistence/cmsLoopSources'
import { CMS_PLUGINS_CHANGED_EVENT } from '@plugins/utils/pluginEvents'
import { LOOP_SOURCES_STALE_EVENT } from '@site/canvas/loopSourceEvents'
import { refreshRemoteLoopPreviews } from '@site/canvas/remoteLoopPreviews'

export function usePluginLoopSources(): void {
  // Answers can arrive out of order; only the latest request may write.
  const latestRequest = useRef(0)
  // The list as last applied, to tell a changed list from the same one again.
  const applied = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false

    function refresh() {
      latestRequest.current += 1
      const request = latestRequest.current
      listCmsLoopSources()
        .then((sources) => {
          if (cancelled || request !== latestRequest.current) return
          const serialized = JSON.stringify(sources)
          const changed = applied.current !== null && applied.current !== serialized
          applied.current = serialized
          replaceRemoteLoopSources(sources)
          // A source that changed hands or shape must not keep an old sample.
          // The first list changes nothing a loop has already asked about.
          if (changed) refreshRemoteLoopPreviews()
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
    window.addEventListener(CMS_PLUGINS_CHANGED_EVENT, refresh)
    window.addEventListener(LOOP_SOURCES_STALE_EVENT, refresh)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      cancelled = true
      window.removeEventListener(CMS_PLUGINS_CHANGED_EVENT, refresh)
      window.removeEventListener(LOOP_SOURCES_STALE_EVENT, refresh)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [])
}
