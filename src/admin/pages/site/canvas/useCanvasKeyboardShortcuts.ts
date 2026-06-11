/**
 * useCanvasKeyboardShortcuts — canvas-focused keyboard handler.
 *
 * Single source of truth for the canvas-level shortcuts that act on the
 * current selection. The handler delegates to `useCanvas` for zoom/pan
 * keys, runs an Escape branch that also exits VC mode, then routes the
 * remaining keys through the keybindings registry into per-family
 * helpers (delete / duplicate / clipboard).
 *
 * Splitting out of `CanvasRoot` keeps "add a new layers.* shortcut" a
 * one-line edit inside this file rather than a churn-y diff against the
 * 500+ line canvas component.
 */

import { useEditorStore } from '@site/store/store'
import type { ActiveDocument } from '@site/store/slices/uiSlice'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'

type CanvasKeyEvent = React.KeyboardEvent<HTMLDivElement>

interface CanvasKeyboardShortcutsDeps {
  /** Forwarded gesture handler (zoom / pan keys). Always runs first. */
  canvasKeyDown: (event: CanvasKeyEvent) => void
  /** Anchor node id — the canvas only reacts when something is selected. */
  selectedNodeId: string | null
  /** True when the canvas is editable (false for read-only / preview). */
  editable: boolean
  /** Drives the VC-mode-exit branch on Escape. */
  activeDocument: ActiveDocument | null
  setActiveDocument: (next: ActiveDocument | null) => void
  /** Selection clearing happens unconditionally on Escape. */
  clearSelection: () => void
  /** Delete branch — routes through the editor confirm flow for a single node. */
  requestDeleteNode: (nodeId: string) => void
  deleteNodes: (nodeIds: string[]) => void
  duplicateNode: (nodeId: string) => void
  duplicateNodes: (nodeIds: string[]) => void
  copyNode: (nodeId: string) => void
  copyNodes: (nodeIds: string[]) => void
  cutNode: (nodeId: string) => void
  cutNodes: (nodeIds: string[]) => void
  pasteNode: (nodeId: string) => void
}

/** Inputs / textareas / contenteditable surfaces let the browser own the keystroke. */
function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  )
}

function runDeleteShortcut(
  event: CanvasKeyEvent,
  selectedNodeId: string,
  currentIds: readonly string[],
  deps: Pick<CanvasKeyboardShortcutsDeps, 'requestDeleteNode' | 'deleteNodes' | 'clearSelection'>,
): void {
  // Don't intercept backspace while the user is typing in a field.
  if (isTextInputTarget(event.target)) return
  event.preventDefault()
  if (currentIds.length > 1) {
    // Multi-delete skips the central confirm dialog for v1 — undo via Ctrl+Z.
    deps.deleteNodes([...currentIds])
    deps.clearSelection()
  } else {
    deps.requestDeleteNode(selectedNodeId)
  }
}

function runDuplicateShortcut(
  event: CanvasKeyEvent,
  selectedNodeId: string,
  currentIds: readonly string[],
  deps: Pick<CanvasKeyboardShortcutsDeps, 'duplicateNode' | 'duplicateNodes'>,
): void {
  event.preventDefault()
  if (currentIds.length > 1) {
    deps.duplicateNodes([...currentIds])
  } else {
    deps.duplicateNode(selectedNodeId)
  }
}

type ClipboardDeps = Pick<
  CanvasKeyboardShortcutsDeps,
  'copyNode' | 'copyNodes' | 'cutNode' | 'cutNodes' | 'pasteNode'
>

function runClipboardShortcut(
  event: CanvasKeyEvent,
  selectedNodeId: string,
  currentIds: readonly string[],
  deps: ClipboardDeps,
): boolean {
  // Skip when the active element is a text input / contenteditable so the
  // browser's native text-clipboard wins when the user is editing a value.
  if (isTextInputTarget(event.target)) return false

  if (getKeybindingForCommand('layers.copy')?.match(event)) {
    event.preventDefault()
    if (currentIds.length > 1) deps.copyNodes([...currentIds])
    else deps.copyNode(selectedNodeId)
    return true
  }
  if (getKeybindingForCommand('layers.cut')?.match(event)) {
    event.preventDefault()
    if (currentIds.length > 1) deps.cutNodes([...currentIds])
    else deps.cutNode(selectedNodeId)
    return true
  }
  if (getKeybindingForCommand('layers.paste')?.match(event)) {
    event.preventDefault()
    // Paste anchors to the multi-selection's anchor — same single target.
    deps.pasteNode(selectedNodeId)
    return true
  }
  return false
}

/** Returns the canvas keydown handler. */
export function useCanvasKeyboardShortcuts(
  deps: CanvasKeyboardShortcutsDeps,
): (event: CanvasKeyEvent) => void {
  const {
    canvasKeyDown,
    selectedNodeId,
    editable,
    activeDocument,
    setActiveDocument,
    clearSelection,
    requestDeleteNode,
    deleteNodes,
    duplicateNode,
    duplicateNodes,
    copyNode,
    copyNodes,
    cutNode,
    cutNodes,
    pasteNode,
  } = deps

  return (event: CanvasKeyEvent) => {
    // While inline editing, the contentEditable node (inside a breakpoint
    // iframe) owns the keyboard. Its keystrokes bubble through React to this
    // parent handler, and the per-shortcut `isTextInputTarget` guard can't see
    // a cross-realm iframe element, so suppress ALL canvas shortcuts up front —
    // Delete/Cmd+D/copy/paste must never fire mid-edit. The editing element's
    // own onKeyDown handles Escape (cancel) and Enter (commit).
    if (useEditorStore.getState().activeInlineEdit) return

    // Zoom / pan keys always run, regardless of selection state.
    canvasKeyDown(event)

    // Escape exits VC mode regardless of selection (SF-1 / CR #666). This
    // must run before the selectedNodeId guard so pressing Escape while in
    // VC mode with nothing selected still returns to the page canvas.
    if (event.key === 'Escape') {
      clearSelection()
      if (activeDocument?.kind === 'visualComponent') {
        setActiveDocument(null)
      }
      return
    }

    if (!editable) return
    if (!selectedNodeId) return

    // Read the live selection set inside the handler so multi-actions see
    // the latest state without subscribing the component to selectedNodeIds.
    const currentIds = useEditorStore.getState().selectedNodeIds

    if (getKeybindingForCommand('layers.delete')?.match(event)) {
      runDeleteShortcut(event, selectedNodeId, currentIds, {
        requestDeleteNode,
        deleteNodes,
        clearSelection,
      })
      return
    }

    if (getKeybindingForCommand('layers.duplicate')?.match(event)) {
      runDuplicateShortcut(event, selectedNodeId, currentIds, {
        duplicateNode,
        duplicateNodes,
      })
      return
    }

    runClipboardShortcut(event, selectedNodeId, currentIds, {
      copyNode,
      copyNodes,
      cutNode,
      cutNodes,
      pasteNode,
    })
  }
}
