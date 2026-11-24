import { useEffect } from 'react'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { useEditorStore } from '@site/store/store'

const kbUndo = getKeybindingForCommand('editor.undo')
const kbRedo = getKeybindingForCommand('editor.redo')

export function canvasHistoryCommand(e: KeyboardEvent): 'undo' | 'redo' | null {
  if (e.defaultPrevented || e.isComposing) return null
  const target = e.target as HTMLElement | null
  if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' ||
      target?.tagName === 'SELECT' || target?.isContentEditable) return null
  if (kbUndo?.match(e)) return 'undo'
  if (kbRedo?.match(e)) return 'redo'
  return null
}

/** Canvas history stays available when a plugin takes over the toolbar. */
export function useCanvasHistoryShortcuts(editable: boolean) {
  useEffect(() => {
    if (!editable) return
    function onKeyDown(e: KeyboardEvent) {
      const command = canvasHistoryCommand(e)
      if (!command) return
      const editor = useEditorStore.getState()
      if (editor.activeInlineEdit) return
      e.preventDefault()
      editor[command]()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editable])
}
