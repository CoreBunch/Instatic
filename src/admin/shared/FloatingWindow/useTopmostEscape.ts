/**
 * Escape-to-close for a floating panel, honouring whatever is stacked above it.
 *
 * Every overlay in this admin takes Escape — the settings modal, the shared
 * `Dialog`, Spotlight. The draggable windows did not: they overlay the grid
 * they were opened from, and the only way out was the header's close button.
 *
 * The stacking check is the same one `SettingsModal` uses, and it is the
 * reason this is a hook rather than three copies. A window can open a
 * `Dialog` of its own — a delete confirmation, the replace-file picker — and
 * that dialog must own Escape until it closes. Without the check, one press
 * would collapse the confirmation and the window underneath it together.
 *
 * `alertdialog` counts as a layer: `Dialog` renders that role instead of
 * `dialog` when `tone === 'danger'`, which is exactly what a destructive
 * confirmation opened from one of these windows is.
 *
 * So does `menu`. A context menu opened inside a window owns Escape while it
 * is up — closing the menu and the window together on one press loses the
 * user's place. Menus portal to `document.body`, so they are not descendants
 * of the panel and the document-order test alone would miss them.
 */

import { useEffect, useEffectEvent, type RefObject } from 'react'

export function useTopmostEscape(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  // `useEffectEvent` keeps `onClose` out of the dependency array — callers
  // pass an inline arrow, and re-subscribing the listener on every render
  // would drop keystrokes between removal and re-add.
  const closeEvent = useEffectEvent(() => onClose())

  useEffect(() => {
    if (!open) return undefined

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return
      const self = panelRef.current
      if (!self) return

      // An open menu owns Escape wherever it sits — it is a transient layer
      // above everything, and unlike a dialog it may render before the panel
      // in document order.
      if (document.querySelector('[role="menu"]')) return

      const stackedAbove = Array.from(
        document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
      ).some(
        (el) =>
          el !== self
          && Boolean(self.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
      )
      if (stackedAbove) return

      event.preventDefault()
      event.stopPropagation()
      closeEvent()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, panelRef])
}
