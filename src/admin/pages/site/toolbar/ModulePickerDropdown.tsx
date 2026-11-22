/**
 * ModulePickerDropdown — toolbar "+ Add" trigger that opens the module
 * inserter command center.
 *
 * The trigger is a small primary button rendered inside the toolbar. Clicking
 * it opens a modal command surface with registry modules, seeded layout
 * presets, saved Visual Components, recents, and drag-to-canvas insertion.
 *
 * Page / Component creation lives elsewhere (Site Explorer) — this dropdown is
 * exclusively about inserting nodes into the current page.
 *
 * Insertion is delegated to the shared `useInsertInserterItem` hook, which the
 * canvas selection toolbar's "Insert module" action also uses, so both entry
 * points resolve the target and dispatch identically (cycle detection +
 * VC/page-mode routing applied uniformly via `insertComponentRef`). See
 * `src/__tests__/architecture/component-system-placement.test.ts`.
 */

import { useMobileViewport } from '@admin/lib/mobileViewport'
import { useRef, useState } from 'react'
import { AppGridPlusGlyphIcon } from 'pixel-art-icons/icons/app-grid-plus-glyph'
import { Button } from '@ui/components/Button'
import { ModuleInserterDialog } from '@site/module-picker/ModuleInserterDialog'
import { useInsertInserterItem } from '@site/hooks/useInsertInserterItem'

interface ModulePickerDropdownProps {
  triggerClassName?: string
  triggerTestId?: string
}

export function ModulePickerDropdown({
  triggerClassName,
  triggerTestId = 'toolbar-add-module-btn',
}: ModulePickerDropdownProps = {}) {
  const phone = useMobileViewport()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const handleInsertItem = useInsertInserterItem()

  const handleOpen = () => setOpen(true)

  return (
    <>
      <Button
        ref={triggerRef}
        variant="primary"
        size={phone ? 'md' : 'sm'}
        iconOnly={!phone}
        accentFill
        className={triggerClassName}
        aria-label="Add to canvas"
        aria-haspopup="dialog"
        aria-expanded={open}
        tooltip="Add to canvas"
        onClick={handleOpen}
        data-testid={triggerTestId}
      >
        <AppGridPlusGlyphIcon size={13} aria-hidden="true" />
        {phone && 'Add'}
      </Button>

      {open && (
        <ModuleInserterDialog
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          onInsertItem={handleInsertItem}
        />
      )}
    </>
  )
}
