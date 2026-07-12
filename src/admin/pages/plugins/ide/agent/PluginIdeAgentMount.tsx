/** The docked Plugin IDE agent UI. Tool registration lives at page level. */
import { useEffect, useState } from 'react'
import { AgentStoreProvider } from '@admin/ai/AgentStoreContext'
import { AgentPanel } from '@site/panels/AgentPanel'
import { createPluginAgentStore } from './pluginAgentStore'

interface PluginIdeAgentMountProps {
  isVisible: boolean
}

export function PluginIdeAgentMount({ isVisible }: PluginIdeAgentMountProps) {
  const [store] = useState(() => createPluginAgentStore())

  useEffect(() => {
    if (isVisible) store.getState().openAgent()
    else store.getState().closeAgent()
  }, [isVisible, store])

  return (
    <AgentStoreProvider store={store}>
      <AgentPanel variant="docked" />
    </AgentStoreProvider>
  )
}
