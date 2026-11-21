import type { ReactNode } from 'react'

/** One destination in the admin section navigation. */
export interface AdminNavEntry {
  key: string
  to: string
  label: string
  icon: ReactNode
  /** The user is on this section right now. */
  active: boolean
  /** Trailing status marker (the Plugins error dot). */
  badge?: ReactNode
}
