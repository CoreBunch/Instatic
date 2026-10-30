import { useEffect, useState, type ReactNode } from 'react'
import { createUpdatesStore } from './store'
import { UpdatesContext } from './UpdatesContext'

export function UpdatesProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [store] = useState(createUpdatesStore)
  useEffect(() => {
    if (enabled) store.start()
    return () => store.stop()
  }, [enabled, store])
  return <UpdatesContext.Provider value={enabled ? store : null}>{children}</UpdatesContext.Provider>
}
