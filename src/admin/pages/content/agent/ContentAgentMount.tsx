/** The docked Content agent UI. Tool registration lives at ContentPage level. */
import { useEffect, useState } from 'react'
import { AgentStoreProvider } from '@admin/ai/AgentStoreContext'
import { AgentPanel } from '@site/panels/AgentPanel'
import { createContentAgentStore } from './contentAgentStore'

interface ContentAgentMountProps {
  isVisible: boolean
}

export function ContentAgentMount({ isVisible }: ContentAgentMountProps) {
  const [store] = useState(() => createContentAgentStore())

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
