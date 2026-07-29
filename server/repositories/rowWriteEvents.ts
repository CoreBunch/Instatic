/**
 * Row-write notification seam — repositories announce writes; interested
 * layers subscribe. Exists so the collab relay (server/collab) can reset
 * CRDT documents when a row is written OUTSIDE the relay (plugin pack
 * installs, HTTP site saves, data-workspace edits) WITHOUT repositories
 * importing upward into server/collab.
 *
 * The relay's own persistence passes `collabInternal: true` through the
 * repository write functions, which then skip the notification — otherwise
 * every relay persist would reset the very documents it just persisted.
 */

export type RowWriteKind = 'create' | 'update' | 'delete'

export interface RowWriteEvent {
  tableId: string
  rowIds: readonly string[]
  kind: RowWriteKind
}

type RowWriteListener = (event: RowWriteEvent) => void

const listeners = new Set<RowWriteListener>()

export function registerRowWriteListener(listener: RowWriteListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyRowWrite(event: RowWriteEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('[rowWriteEvents] listener failed:', err)
    }
  }
}

/** The shell (site row) equivalent — same seam, no table id. */
type ShellWriteListener = () => void
const shellListeners = new Set<ShellWriteListener>()

export function registerShellWriteListener(listener: ShellWriteListener): () => void {
  shellListeners.add(listener)
  return () => shellListeners.delete(listener)
}

export function notifyShellWrite(): void {
  for (const listener of shellListeners) {
    try {
      listener()
    } catch (err) {
      console.error('[rowWriteEvents] shell listener failed:', err)
    }
  }
}
