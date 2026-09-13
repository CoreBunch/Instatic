import { useEffect } from 'react'
import { AdminCanvasLayout } from '@admin/layouts/AdminCanvasLayout'
import { consumePendingAction } from '@admin/spotlight/pendingAction'
import { useEditorStore } from '@site/store/store'
import { useMcpWorkspaceBridge } from '@admin/ai/useMcpWorkspaceBridge'
import { executeAgentTool } from './agent'

/**
 * SitePage — visual editor route.
 *
 * The route renders the real admin/site shell immediately. Heavy editor body
 * work (DnD, canvas, panels, module registration, CodeMirror panel mount) is
 * lazy-loaded one level down by AdminCanvasLayout after the shell has painted.
 */
export function SitePage() {
  const siteHydrated = useEditorStore((state) => state.site !== null)

  // Relay MCP browser-tool calls to this open editor while it's mounted. No
  // post-tool persistence step: store mutations stream to the relay through the
  // collab socket the moment they land, and every headless MCP read flushes the
  // relay server-side first (see server/ai/mcp/server.ts), so a follow-up read
  // always observes the edit. Delay registration until the editor store is
  // hydrated so get_context's siteConnected flag means browser tools can
  // actually see an active site.
  useMcpWorkspaceBridge('site', executeAgentTool, undefined, siteHydrated)

  // Consume cross-workspace pending actions queued by the spotlight. Each
  // action waits for the editor store to hydrate (site !== null) — we
  // subscribe once and tear down as soon as the action has fired so the
  // listener doesn't outlive the editor mount.
  useEffect(() => {
    function runIfHydrated(): boolean {
      const store = useEditorStore.getState()
      if (!store.site) return false

      const newPage = consumePendingAction('site.newPage')
      if (newPage) {
        const title = newPage.args?.['title']?.trim()
        if (title) store.addPage(title)
        return true
      }

      const newVc = consumePendingAction('site.newVisualComponent')
      if (newVc) {
        const name = newVc.args?.['name']?.trim()
        if (name) {
          const vcId = store.createVisualComponent(name)
          store.setActiveDocument({ kind: 'visualComponent', vcId })
        }
        return true
      }

      return true // hydrated but nothing queued — stop waiting
    }

    if (runIfHydrated()) return

    const unsubscribe = useEditorStore.subscribe(() => {
      if (runIfHydrated()) unsubscribe()
    })
    return unsubscribe
  }, [])

  return <AdminCanvasLayout />
}
