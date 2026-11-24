/**
 * UndoRedoButtons — Undo and Redo controls inside the canvas notch.
 *
 * Lives next to the quick-insert actions because undo/redo only operates
 * on the visual editor's page tree — it has no meaning on admin pages
 * outside the canvas (Content, Plugins, …).
 *
 * Accessibility (Guideline #224):
 * - Buttons are ALWAYS rendered in the DOM — never conditionally removed.
 * - When unavailable: aria-disabled="true" + visual grey. NOT the `disabled` HTML attr.
 * - aria-keyshortcuts documents the keyboard shortcut for screen readers.
 *
 * Shortcut display strings come from the keybindings registry (keybindings.ts)
 * — not hardcoded here.
 */
import { useMobileViewport } from '@admin/lib/mobileViewport'
import { useCanUndo, useCanRedo, useUndo, useRedo } from '@site/store/store'
import { UndoIcon } from 'pixel-art-icons/icons/undo'
import { RedoIcon } from 'pixel-art-icons/icons/redo'
import { Button } from '@ui/components/Button'
import { getKeybindingForCommand, formatShortcut } from '@admin/spotlight/keybindings'
import styles from './CanvasNotch.module.css'

// Resolve undo/redo bindings once at module load — they never change.
const kbUndo = getKeybindingForCommand('editor.undo')
const kbRedo = getKeybindingForCommand('editor.redo')

export function UndoRedoButtons() {
  const phone = useMobileViewport()
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()
  const undo = useUndo()
  const redo = useRedo()

  // Shortcut labels from the registry — platform-aware.
  const undoHint = kbUndo ? formatShortcut(kbUndo.shortcut) : ''
  const redoHint = kbRedo ? formatShortcut(kbRedo.shortcut) : ''

  return (
    <div
      role="group"
      aria-label="Undo and redo"
      className={styles.historyGroup}
    >
      <Button
        variant="ghost"
        size={phone ? 'md' : 'sm'}
        iconOnly
        className={styles.quickButton}
        aria-label="Undo"
        aria-keyshortcuts={kbUndo?.ariaKeyshortcuts}
        aria-disabled={!canUndo}
        onClick={canUndo ? undo : undefined}
        tooltip={undoHint ? `Undo (${undoHint})` : 'Undo'}
        data-testid="canvas-notch-undo-btn"
      >
        <UndoIcon size={14} aria-hidden="true" />
      </Button>

      <Button
        variant="ghost"
        size={phone ? 'md' : 'sm'}
        iconOnly
        className={styles.quickButton}
        aria-label="Redo"
        aria-keyshortcuts={kbRedo?.ariaKeyshortcuts}
        aria-disabled={!canRedo}
        onClick={canRedo ? redo : undefined}
        tooltip={redoHint ? `Redo (${redoHint})` : 'Redo'}
        data-testid="canvas-notch-redo-btn"
      >
        <RedoIcon size={14} aria-hidden="true" />
      </Button>
    </div>
  )
}
