import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { getKeybindingForCommand } from '../keybindings'
import { findMatchingShortcutCommand } from '../shortcutDispatch'
import type { CommandContext } from '../types'
import {
  EDITOR_PREFS_KEY,
  setEditorPreference,
} from '@site/preferences/editorPreferences'

const SPOTLIGHT_ROOT = new URL('../SpotlightRoot.tsx', import.meta.url)

afterEach(() => {
  localStorage.removeItem(EDITOR_PREFS_KEY)
})

function eventLike(key: string, overrides: Partial<KeyboardEvent> = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  }
}

function context(capabilities: string[], editor?: CommandContext['editor']): CommandContext {
  return {
    workspace: 'site',
    pathname: '/admin/site',
    user: {
      id: 'user-1',
      email: 'owner@example.com',
      name: 'Owner',
      roleId: 'role-owner',
      roleName: 'Owner',
      capabilities,
    },
    editor,
  } as CommandContext
}

function canvasTarget() {
  return {
    tagName: 'DIV',
    isContentEditable: false,
    closest: (selector: string) =>
      selector === '[data-instatic-canvas-root="true"]' ? {} : null,
  }
}

function layerTreeTarget() {
  return {
    tagName: 'DIV',
    isContentEditable: false,
    closest: (selector: string) =>
      selector === '[data-instatic-layer-tree="true"]' ? {} : null,
  }
}

describe('command shortcut dispatch', () => {
  it('registers Cmd/Ctrl+I for opening the AI assistant panel', () => {
    const binding = getKeybindingForCommand('ai.open')

    expect(binding).toBeDefined()
    expect(binding?.shortcut).toEqual({ mac: '⌘I', win: 'Ctrl+I' })
    expect(binding?.scope).toBe('panels')
    expect(binding?.match(eventLike('i', { metaKey: true }))).toBe(true)
    expect(binding?.match(eventLike('i', { ctrlKey: true }))).toBe(true)
  })

  it('SpotlightRoot dispatches registered command shortcuts beyond Cmd+K', () => {
    const src = readFileSync(SPOTLIGHT_ROOT, 'utf-8')

    expect(src).toContain('findMatchingShortcutCommand')
    expect(src).toContain('void runCommand(shortcutCommand)')
  })

  it('resolves Cmd/Ctrl+I to the AI command only when ai.chat is available', () => {
    const allowed = findMatchingShortcutCommand(
      eventLike('i', { metaKey: true }) as KeyboardEvent,
      context(['site.read', 'ai.chat']),
    )
    const denied = findMatchingShortcutCommand(
      eventLike('i', { metaKey: true }) as KeyboardEvent,
      context(['site.read']),
    )

    expect(allowed?.id).toBe('ai.open')
    expect(denied).toBeNull()
  })

  it('resolves canvas clipboard shortcuts only from the canvas focus surface', () => {
    const ctx = context(['site.read'], {
      selectedNodeIds: ['node-1'],
      activePageId: 'page-1',
      activeDocument: { kind: 'page', pageId: 'page-1' },
      canUndo: false,
      canRedo: false,
      activeBreakpointId: 'desktop',
      activeInlineEdit: false,
    })
    const fromCanvas = findMatchingShortcutCommand(
      eventLike('c', { metaKey: true, target: canvasTarget() as EventTarget }) as KeyboardEvent,
      ctx,
    )
    const outsideCanvas = findMatchingShortcutCommand(
      eventLike('c', { metaKey: true }) as KeyboardEvent,
      ctx,
    )

    expect(fromCanvas?.id).toBe('layers.copy')
    expect(outsideCanvas).toBeNull()
  })

  it('resolves layer clipboard shortcuts from the Layers tree focus surface', () => {
    const ctx = context(['site.read'], {
      selectedNodeIds: ['node-1'],
      activePageId: 'page-1',
      activeDocument: { kind: 'page', pageId: 'page-1' },
      canUndo: false,
      canRedo: false,
      activeBreakpointId: 'desktop',
      activeInlineEdit: false,
    })

    const command = findMatchingShortcutCommand(
      eventLike('c', { metaKey: true, target: layerTreeTarget() as EventTarget }) as KeyboardEvent,
      ctx,
    )

    expect(command?.id).toBe('layers.copy')
  })

  it('registers Cmd/Ctrl+Backspace for deleting the selected layer', () => {
    const binding = getKeybindingForCommand('layers.delete')

    expect(binding).toBeDefined()
    expect(binding?.shortcut).toEqual({ mac: '⌘⌫', win: 'Ctrl+Backspace' })
    expect(binding?.match(eventLike('Backspace', { metaKey: true }))).toBe(true)
    expect(binding?.match(eventLike('Backspace', { ctrlKey: true }))).toBe(true)
  })

  it('registers optional ArrowUp/ArrowDown shortcuts for moving layers', () => {
    const moveUp = getKeybindingForCommand('layers.moveUp')
    const moveDown = getKeybindingForCommand('layers.moveDown')

    expect(moveUp?.shortcut).toEqual({ mac: '↑', win: '↑' })
    expect(moveDown?.shortcut).toEqual({ mac: '↓', win: '↓' })
    expect(moveUp?.match(eventLike('ArrowUp'))).toBe(true)
    expect(moveDown?.match(eventLike('ArrowDown'))).toBe(true)
    expect(moveUp?.match(eventLike('ArrowUp', { altKey: true }))).toBe(false)
    expect(moveDown?.match(eventLike('ArrowDown', { shiftKey: true }))).toBe(false)
  })

  it('dispatches layer movement only when the Arrow-key preference is enabled', () => {
    const ctx = context(['site.read', 'site.structure.edit'], {
      selectedNodeIds: ['node-1'],
      activePageId: 'page-1',
      activeDocument: { kind: 'page', pageId: 'page-1' },
      canUndo: false,
      canRedo: false,
      activeBreakpointId: 'desktop',
      activeInlineEdit: false,
    })
    const event = () =>
      eventLike('ArrowUp', { target: canvasTarget() as EventTarget }) as KeyboardEvent

    expect(findMatchingShortcutCommand(event(), ctx)).toBeNull()

    setEditorPreference('layersArrowKeyReorder', true)
    expect(findMatchingShortcutCommand(event(), ctx)?.id).toBe('layers.moveUp')
    expect(
      findMatchingShortcutCommand(
        eventLike('ArrowDown', { target: layerTreeTarget() as EventTarget }) as KeyboardEvent,
        ctx,
      )?.id,
    ).toBe('layers.moveDown')
  })

  it('matches browser-uppercase canvas clipboard shortcut keys', () => {
    const ctx = context(['site.read', 'site.structure.edit'], {
      selectedNodeIds: ['node-1'],
      activePageId: 'page-1',
      activeDocument: { kind: 'page', pageId: 'page-1' },
      canUndo: false,
      canRedo: false,
      activeBreakpointId: 'desktop',
      activeInlineEdit: false,
    })

    expect(
      findMatchingShortcutCommand(
        eventLike('C', { metaKey: true, target: canvasTarget() as EventTarget }) as KeyboardEvent,
        ctx,
      )?.id,
    ).toBe('layers.copy')
    expect(
      findMatchingShortcutCommand(
        eventLike('X', { metaKey: true, target: canvasTarget() as EventTarget }) as KeyboardEvent,
        ctx,
      )?.id,
    ).toBe('layers.cut')
    expect(
      findMatchingShortcutCommand(
        eventLike('V', { metaKey: true, target: canvasTarget() as EventTarget }) as KeyboardEvent,
        ctx,
      )?.id,
    ).toBe('layers.paste')
  })

  it('does not run canvas shortcuts during inline text editing', () => {
    const ctx = context(['site.read', 'site.structure.edit'], {
      selectedNodeIds: ['node-1'],
      activePageId: 'page-1',
      activeDocument: { kind: 'page', pageId: 'page-1' },
      canUndo: false,
      canRedo: false,
      activeBreakpointId: 'desktop',
      activeInlineEdit: true,
    })

    const command = findMatchingShortcutCommand(
      eventLike('C', { metaKey: true, target: canvasTarget() as EventTarget }) as KeyboardEvent,
      ctx,
    )

    expect(command).toBeNull()
  })
})
