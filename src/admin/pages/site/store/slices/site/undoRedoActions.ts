/**
 * Undo/redo actions for the site slice — thin delegates into the collab
 * binding's per-doc Y.UndoManager routing (see collabBinding.ts). The undone
 * state flows back into the store through the binding's projection path, so
 * these actions never touch `site` directly.
 */

import { collabRedo, collabUndo } from './collabBinding'
import type { SiteSlice } from './types'

type UndoRedoActions = Pick<SiteSlice, 'undo' | 'redo'>

export function createUndoRedoActions(): UndoRedoActions {
  return {
    undo: () => {
      collabUndo()
    },
    redo: () => {
      collabRedo()
    },
  }
}
