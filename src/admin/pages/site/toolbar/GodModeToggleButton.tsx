/**
 * GodModeToggleButton — toolbar entry point for God Mode (⌘⇧G).
 *
 * Self-gating: renders nothing unless the `godMode` editor preference is on
 * AND the user holds structure-edit rights (useGodModeUnlocked). The same
 * gate clears a persisted-active flag in AdminCanvasEditorBody, so the
 * button and the dock can never disagree.
 */
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { useEditorStore } from '@site/store/store'
import { useGodModeUnlocked } from '@site/hooks/useGodModeUnlocked'
import { formatShortcut, getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { Button } from '@ui/components/Button'

export function GodModeToggleButton() {
  const unlocked = useGodModeUnlocked()
  const active = useEditorStore((s) => s.godModeActive)
  const toggleGodMode = useEditorStore((s) => s.toggleGodMode)

  if (!unlocked) return null

  const binding = getKeybindingForCommand('godMode.toggle')
  const shortcut = binding ? ` (${formatShortcut(binding.shortcut)})` : ''

  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      pressed={active}
      aria-label={active ? 'Exit God Mode' : 'Enter God Mode'}
      tooltip={(active ? 'Exit God Mode' : 'God Mode') + shortcut}
      onClick={toggleGodMode}
      data-testid="toolbar-god-mode-btn"
    >
      <CodeIcon size={16} aria-hidden="true" />
    </Button>
  )
}
