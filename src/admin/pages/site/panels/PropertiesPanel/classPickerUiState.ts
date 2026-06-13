/** classPickerUiState — reducer-driven UI state for the ClassPicker container. */

import type { StyleRule } from '@core/page-tree'

export interface ClassContextMenuState {
  x: number
  y: number
  classId: string
}

interface ClassPickerUiState {
  query: string
  showSuggestions: boolean
  contextMenu: ClassContextMenuState | null
  renameTarget: StyleRule | null
  createError: string | null
  highlightedIndex: number
}

type ClassPickerUiAction =
  | { type: 'inputChanged'; query: string }
  | { type: 'openSuggestions' }
  | { type: 'closeSuggestions' }
  | { type: 'resetAfterSubmit' }
  | { type: 'setContextMenu'; contextMenu: ClassContextMenuState | null }
  | { type: 'setRenameTarget'; renameTarget: StyleRule | null }
  | { type: 'setCreateError'; message: string | null }
  | { type: 'moveHighlight'; direction: 'next' | 'previous'; count: number }

export const initialClassPickerUiState: ClassPickerUiState = {
  query: '',
  showSuggestions: false,
  contextMenu: null,
  renameTarget: null,
  createError: null,
  highlightedIndex: -1,
}

export function classPickerUiReducer(
  state: ClassPickerUiState,
  action: ClassPickerUiAction,
): ClassPickerUiState {
  switch (action.type) {
    case 'inputChanged':
      return {
        ...state,
        query: action.query,
        showSuggestions: true,
        createError: null,
        highlightedIndex: -1,
      }
    case 'openSuggestions':
      return { ...state, showSuggestions: true }
    case 'closeSuggestions':
      return { ...state, showSuggestions: false, highlightedIndex: -1 }
    case 'resetAfterSubmit':
      return {
        ...state,
        query: '',
        showSuggestions: false,
        createError: null,
        highlightedIndex: -1,
      }
    case 'setContextMenu':
      return { ...state, contextMenu: action.contextMenu }
    case 'setRenameTarget':
      return { ...state, renameTarget: action.renameTarget }
    case 'setCreateError':
      return { ...state, createError: action.message, showSuggestions: false, highlightedIndex: -1 }
    case 'moveHighlight': {
      if (action.count <= 0) return state
      if (action.direction === 'next') {
        const next = state.highlightedIndex + 1
        return {
          ...state,
          showSuggestions: true,
          highlightedIndex: next >= action.count ? 0 : next,
        }
      }
      return {
        ...state,
        showSuggestions: true,
        highlightedIndex:
          state.highlightedIndex <= 0 ? action.count - 1 : state.highlightedIndex - 1,
      }
    }
  }
}
