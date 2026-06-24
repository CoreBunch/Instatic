/**
 * CanvasInsertModuleButton — "Insert module" action for the canvas selection
 * toolbar. Renders a single toolbar button that opens the full-screen
 * `ModuleInserterDialog` — the exact same command surface as the main toolbar's
 * "+ Add" button — instead of an anchored dropdown (which mis-positioned
 * relative to the zoom/transform-scaled canvas and its breakpoint iframes).
 *
 * Insertion routes through the shared `useInsertInserterItem` hook, so the
 * picked node lands relative to the current selection: the dialog passes no
 * explicit target on click, and `useInsertModule` → `resolveInsertLocation`
 * resolves it from `selectedNodeId` — container targets nest the new node as a
 * last child, leaf targets get a sibling-after insertion under their parent.
 */

import { useRef, useState } from 'react'
import { AppGridPlusGlyphIcon } from 'pixel-art-icons/icons/app-grid-plus-glyph'
import { Button } from '@ui/components/Button'
import { ModuleInserterDialog } from '@site/module-picker/ModuleInserterDialog'
import { useInsertInserterItem } from '@site/hooks/useInsertInserterItem'

interface CanvasInsertModuleButtonProps {
  /** Class applied to the trigger button so it matches the toolbar chrome. */
  buttonClassName?: string
}

export function CanvasInsertModuleButton({
  buttonClassName,
}: CanvasInsertModuleButtonProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const handleInsertItem = useInsertInserterItem()

  const handleClose = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <>
      <Button
        ref={triggerRef}
        variant="secondary"
        size="xs"
        iconOnly
        aria-label="Insert module"
        aria-haspopup="dialog"
        aria-expanded={open}
        tooltip="Insert module"
        className={buttonClassName}
        onClick={() => setOpen(true)}
      >
        <AppGridPlusGlyphIcon size={13} color="var(--text)" />
      </Button>

      {open && (
        <ModuleInserterDialog
          onClose={handleClose}
          onInsertItem={handleInsertItem}
        />
      )}
    </>
  )
}
