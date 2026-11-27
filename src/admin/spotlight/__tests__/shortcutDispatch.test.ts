import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { getKeybindingForCommand } from '../keybindings'
import { findMatchingShortcutCommand } from '../shortcutDispatch'
import type { CommandContext } from '../types'

const SPOTLIGHT_ROOT = new URL('../SpotlightRoot.tsx', import.meta.url)

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

  it('resolves a bare H on the canvas to the Hand tool toggle', () => {
    const ctx = context(['site.read'], {
      selectedNodeIds: [],
      activePageId: 'page-1',
      activeDocument: { kind: 'page', pageId: 'page-1' },
      canUndo: false,
      canRedo: false,
      activeBreakpointId: 'desktop',
      activeInlineEdit: false,
    })
    const onCanvas = (key: string, overrides: Partial<KeyboardEvent> = {}) =>
      findMatchingShortcutCommand(
        eventLike(key, { target: canvasTarget() as EventTarget, ...overrides }) as KeyboardEvent,
        ctx,
      )

    expect(onCanvas('h')?.id).toBe('preview.toggleHandTool')
    expect(onCanvas('H')?.id).toBe('preview.toggleHandTool')
    expect(onCanvas('h', { metaKey: true })).toBeNull()
    expect(onCanvas('H', { shiftKey: true })).toBeNull()
    expect(findMatchingShortcutCommand(eventLike('h') as KeyboardEvent, ctx)).toBeNull()
  })

  it('resolves a bare V on the canvas to the Select tool, leaving Cmd+V as paste', () => {
    const ctx = context(['site.read', 'site.structure.edit'], {
      selectedNodeIds: ['node-1'],
      activePageId: 'page-1',
      activeDocument: { kind: 'page', pageId: 'page-1' },
      canUndo: false,
      canRedo: false,
      activeBreakpointId: 'desktop',
      activeInlineEdit: false,
    })
    const onCanvas = (key: string, overrides: Partial<KeyboardEvent> = {}) =>
      findMatchingShortcutCommand(
        eventLike(key, { target: canvasTarget() as EventTarget, ...overrides }) as KeyboardEvent,
        ctx,
      )

    expect(onCanvas('v')?.id).toBe('preview.selectTool')
    expect(onCanvas('V')?.id).toBe('preview.selectTool')
    expect(onCanvas('v', { metaKey: true })?.id).toBe('layers.paste')
    expect(onCanvas('V', { shiftKey: true })).toBeNull()
    expect(findMatchingShortcutCommand(eventLike('v') as KeyboardEvent, ctx)).toBeNull()
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
