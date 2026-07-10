import { useEffect } from 'react'
import { AdminCanvasLayout } from '@admin/layouts/AdminCanvasLayout'
import { consumePendingAction } from '@admin/spotlight/pendingAction'
import { useEditorStore } from '@site/store/store'
import { useMcpWorkspaceBridge } from '@admin/ai/useMcpWorkspaceBridge'
import { executeAgentTool } from './agent'
import { flushEditorSave } from './hooks/editorSaveRef'

async function flushPendingSiteDraft(): Promise<void> {
  if (useEditorStore.getState().hasUnsavedChanges) await flushEditorSave()
}

/**
 * SitePage — visual editor route.
 *
 * The route renders the real admin/site shell immediately. Heavy editor body
 * work (DnD, canvas, panels, module registration, CodeMirror panel mount) is
 * lazy-loaded one level down by AdminCanvasLayout after the shell has painted.
 */
export function SitePage() {
  // Relay MCP browser-tool calls to this open editor while it's mounted.
  useMcpWorkspaceBridge('site', executeAgentTool, flushPendingSiteDraft)

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
