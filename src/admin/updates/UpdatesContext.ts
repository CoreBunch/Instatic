import { createContext } from 'react'
import type { UpdatesStore } from './store'

export const UpdatesContext = createContext<UpdatesStore | null>(null)
