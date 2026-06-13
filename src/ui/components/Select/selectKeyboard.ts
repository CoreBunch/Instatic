import type { KeyboardEvent } from 'react'
import {
  getFirstEnabledOptionIndex,
  getLastEnabledOptionIndex,
  getNextEnabledOptionIndex,
  isEnabledOptionIndex,
  type NormalizedSelectOption,
} from './SelectOption'

interface SelectKeyboardContext {
  open: boolean
  options: NormalizedSelectOption[]
  activeIndex: number
  setActiveIndex: (index: number) => void
  openMenu: () => void
  closeMenu: () => void
  commitValue: (value: string) => void
}

type KeyHandler = (event: KeyboardEvent<HTMLInputElement>, ctx: SelectKeyboardContext) => void

/**
 * Table-driven keyboard dispatch. Each key maps to one handler — adding a new
 * shortcut is a one-line edit on this map instead of another switch branch in
 * the Select body.
 */
const KEY_HANDLERS: Record<string, KeyHandler> = {
  ArrowDown(event, ctx) {
    event.preventDefault()
    if (!ctx.open) {
      ctx.openMenu()
    } else {
      ctx.setActiveIndex(getNextEnabledOptionIndex(ctx.options, ctx.activeIndex, 1))
    }
  },
  ArrowUp(event, ctx) {
    event.preventDefault()
    if (!ctx.open) {
      ctx.openMenu()
    } else {
      ctx.setActiveIndex(getNextEnabledOptionIndex(ctx.options, ctx.activeIndex, -1))
    }
  },
  Home(event, ctx) {
    if (!ctx.open) return
    event.preventDefault()
    ctx.setActiveIndex(getFirstEnabledOptionIndex(ctx.options))
  },
  End(event, ctx) {
    if (!ctx.open) return
    event.preventDefault()
    ctx.setActiveIndex(getLastEnabledOptionIndex(ctx.options))
  },
  Enter: commitOrOpen,
  ' ': commitOrOpen,
  Escape(event, ctx) {
    event.preventDefault()
    ctx.closeMenu()
  },
  Tab(_event, ctx) {
    ctx.closeMenu()
  },
}

function commitOrOpen(event: KeyboardEvent<HTMLInputElement>, ctx: SelectKeyboardContext) {
  event.preventDefault()
  if (!ctx.open) {
    ctx.openMenu()
  } else if (isEnabledOptionIndex(ctx.options, ctx.activeIndex)) {
    ctx.commitValue(ctx.options[ctx.activeIndex].value)
  }
}

export function handleSelectKeyDown(
  event: KeyboardEvent<HTMLInputElement>,
  ctx: SelectKeyboardContext,
): void {
  const handler = KEY_HANDLERS[event.key]
  if (handler) handler(event, ctx)
}
