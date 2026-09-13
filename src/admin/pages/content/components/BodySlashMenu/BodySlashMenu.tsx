/**
 * React renderer for the slash-command menu.
 *
 * Mounted by `TiptapBodyEditor` once per editor instance. The editor
 * holds the public API as a ref (`handleRef.current = { open, update,
 * close }`) so the SlashCommand extension's `render()` lifecycle can
 * drive the menu without dispatching React events on every key.
 *
 * Selection model is local: arrow-up / arrow-down move the active
 * index; Enter invokes the highlighted item's command; Escape closes.
 * The extension calls `onKeyDown` for any key while the menu is open;
 * we return `true` to swallow handled keys.
 */

import { useImperativeHandle, useState, type RefObject } from 'react'
import type { Editor, Range } from '@tiptap/core'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import type { SlashCommandItem } from './SlashCommand'

interface MenuPosition {
  x: number
  y: number
}

export interface SlashMenuHandle {
  open: (
    editor: Editor,
    range: Range,
    items: SlashCommandItem[],
    rect: DOMRect | null,
  ) => void
  update: (range: Range, items: SlashCommandItem[], rect: DOMRect | null) => void
  close: () => void
  /** Returns true if the key was handled and should be swallowed. */
  onKeyDown: (event: KeyboardEvent) => boolean
  isOpen: () => boolean
}

interface BodySlashMenuProps {
  handleRef: RefObject<SlashMenuHandle | null>
}

interface MenuState {
  editor: Editor
  range: Range
  items: SlashCommandItem[]
  position: MenuPosition
}

export function BodySlashMenu({ handleRef }: BodySlashMenuProps) {
  const [state, setState] = useState<MenuState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  // Derived: clamp the active index to the items range without writing
  // back to state, so re-renders don't cascade through an effect.
  const clampedActiveIndex =
    state && state.items.length > 0
      ? Math.min(Math.max(activeIndex, 0), state.items.length - 1)
      : 0

  useImperativeHandle(
    handleRef,
    (): SlashMenuHandle => ({
      open: (editor, range, items, rect) => {
        setState({ editor, range, items, position: rectToPosition(rect) })
        setActiveIndex(0)
      },
      update: (range, items, rect) => {
        setState((current) =>
          current ? { ...current, range, items, position: rectToPosition(rect) } : current,
        )
      },
      close: () => setState(null),
      isOpen: () => state !== null,
      onKeyDown: (event) => {
        if (!state) return false
        const itemCount = state.items.length
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActiveIndex((index) => (itemCount === 0 ? 0 : (index + 1) % itemCount))
          return true
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveIndex((index) => (itemCount === 0 ? 0 : (index - 1 + itemCount) % itemCount))
          return true
        }
        if (event.key === 'Enter') {
          const item = state.items[clampedActiveIndex]
          if (!item) return false
          event.preventDefault()
          item.command({ editor: state.editor, range: state.range })
          setState(null)
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setState(null)
          return true
        }
        return false
      },
    }),
    [clampedActiveIndex, state],
  )

  if (!state || typeof document === 'undefined') return null

  return (
    <ContextMenu
      ariaLabel="Insert block"
      onClose={() => setState(null)}
      x={state.position.x}
      y={state.position.y}
      width={240}
      maxWidth={320}
      maxHeight={360}
      data-testid="content-slash-menu"
    >
      {state.items.length === 0 ? (
        <ContextMenuItem disabled>No matches</ContextMenuItem>
      ) : (
        state.items.map((item, index) => (
          <ContextMenuItem
            key={item.id}
            active={index === clampedActiveIndex}
            onPointerEnter={() => setActiveIndex(index)}
            // The Suggestion plugin clears the menu when the editor loses
            // focus. Preventing the mouse-down focus shift lets the click
            // select the command before that lifecycle runs.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              item.command({ editor: state.editor, range: state.range })
              setState(null)
            }}
          >
            {item.label}
          </ContextMenuItem>
        ))
      )}
    </ContextMenu>
  )
}

function rectToPosition(rect: DOMRect | null): MenuPosition {
  if (!rect) return { x: 0, y: 0 }
  // Anchor below the caret. The Suggestion plugin gives us the caret rect
  // via `clientRect()`; we add a small gap so the menu doesn't crowd the
  // text.
  return { x: Math.round(rect.left), y: Math.round(rect.bottom + 6) }
}
