import { useContext, useSyncExternalStore } from 'react'
import { UpdatesContext } from './UpdatesContext'
import { EMPTY_UPDATES } from './store'

const emptySnapshot = () => EMPTY_UPDATES
const subscribeEmpty = () => () => {}

export function useUpdates() {
  const store = useContext(UpdatesContext)
  const state = useSyncExternalStore(store?.subscribe ?? subscribeEmpty, store?.getSnapshot ?? emptySnapshot, emptySnapshot)
  return { ...state, store }
}
