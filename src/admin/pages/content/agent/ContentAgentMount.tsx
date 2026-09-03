/** The docked Content agent UI. Tool registration lives at ContentPage level. */
import { useEffect, useState } from 'react'
import { AgentStoreProvider } from '@admin/ai/AgentStoreContext'
import { createScopedAgentStore } from '@admin/ai/createScopedAgentStore'
import { AgentPanel } from '@site/panels/AgentPanel'
import { contentAgentSliceConfig } from './agentSliceConfig.content'

interface ContentAgentMountProps {
  isVisible: boolean
}

export function ContentAgentMount({ isVisible }: ContentAgentMountProps) {
  const [store] = useState(() => createScopedAgentStore(contentAgentSliceConfig))

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
