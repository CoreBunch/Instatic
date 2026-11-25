import { createContext, type RefObject } from 'react'

/** Open submenu portals that belong to a ContextMenu's dismissal boundary. */
export const ContextMenuSubmenuContext = createContext<RefObject<Set<HTMLElement>> | null>(null)
