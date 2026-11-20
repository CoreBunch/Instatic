import { useEffect, useRef } from 'react'
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

  // The MCP bridge already subscribes to site hydration. Consume the pending
  // spotlight action once per mount after that same signal becomes ready.
  const consumed = useRef(false)
  useEffect(() => {
    if (!siteHydrated || consumed.current) return
    consumed.current = true
    const store = useEditorStore.getState()
    const newPage = consumePendingAction('site.newPage')
    if (newPage) {
      const title = newPage.args?.title?.trim()
      if (title) store.addPage(title)
      return
    }
    const name = consumePendingAction('site.newVisualComponent')?.args?.name?.trim()
    if (name) {
      const vcId = store.createVisualComponent(name)
      store.setActiveDocument({ kind: 'visualComponent', vcId })
    }
  }, [siteHydrated])

  return <AdminCanvasLayout />
}
