/**
 * Keeps the editor's list of plugin loop sources in line with the server's.
 *
 * Plugins register loop sources in the server process. This hook fetches
 * their descriptors when an editor layout mounts and again whenever the set
 * of plugins changes (`CMS_PLUGINS_CHANGED_EVENT`, the same signal that
 * re-activates editor plugins), and registers them as remote sources so the
 * Loop module's picker, the field bindings and the canvas preview see them.
 *
 * It is separate from `useInstalledEditorPlugins` on purpose: that pass needs
 * access to the Plugins workspace, while using a plugin's source on a page
 * needs only `site.read`.
 */
import { useEffect } from 'react'
import { replaceRemoteLoopSources } from '@core/loops'
import { listCmsLoopSources } from '@core/persistence/cmsLoopSources'
import { isAbortError } from '@core/http'
import { CMS_PLUGINS_CHANGED_EVENT } from '@plugins/utils/pluginEvents'
import { clearRemoteLoopPreviews } from '@site/canvas/useRemoteLoopPreview'

export function usePluginLoopSources(): void {
  useEffect(() => {
    let cancelled = false

    function refresh() {
      listCmsLoopSources()
        .then((sources) => {
          if (cancelled) return
          replaceRemoteLoopSources(sources)
          // A source that changed hands or shape must not keep an old sample.
          clearRemoteLoopPreviews()
        })
        .catch((err: unknown) => {
          // The editor stays usable with built-in sources only.
          if (!cancelled && !isAbortError(err)) {
            console.error('[usePluginLoopSources] Loading plugin loop sources failed:', err)
          }
        })
    }

    refresh()
    window.addEventListener(CMS_PLUGINS_CHANGED_EVENT, refresh)
    return () => {
      cancelled = true
      window.removeEventListener(CMS_PLUGINS_CHANGED_EVENT, refresh)
    }
  }, [])
}
