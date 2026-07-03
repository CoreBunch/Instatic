import { filterCommands, getAllCommands } from './commandRegistry'
import { KEYBINDINGS, type KeyEventLike } from './keybindings'
import type { Command, CommandContext } from './types'

const CANVAS_ROOT_SELECTOR = '[data-instatic-canvas-root="true"]'
const LAYER_TREE_SELECTOR = '[data-instatic-layer-tree="true"]'

const COMPONENT_OWNED_SHORTCUTS = new Set([
  'spotlight.open',
  'editor.undo',
  'editor.redo',
  'layers.delete',
])

function isElementLike(value: unknown): value is Element {
  return typeof value === 'object' && value !== null && 'closest' in value
}

function elementFromTarget(target: EventTarget | null): Element | null {
  return isElementLike(target) ? target : null
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const element = elementFromTarget(target)
  if (!element) return false

  const htmlElement = element as HTMLElement
  const tagName = htmlElement.tagName
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true
  if (htmlElement.isContentEditable) return true

  return Boolean(element.closest('input, textarea, select, [contenteditable="true"]'))
}

function eventDocument(event: KeyboardEvent): Document | null {
  const element = elementFromTarget(event.target)
  if (element?.ownerDocument) return element.ownerDocument
  return typeof document === 'undefined' ? null : document
}

function isLayerShortcutSurface(event: KeyboardEvent): boolean {
  const targetElement = elementFromTarget(event.target)
  if (targetElement?.closest(CANVAS_ROOT_SELECTOR)) return true
  if (targetElement?.closest(LAYER_TREE_SELECTOR)) return true

  const activeElement = eventDocument(event)?.activeElement
  return isElementLike(activeElement) &&
    (Boolean(activeElement.closest(CANVAS_ROOT_SELECTOR)) ||
      Boolean(activeElement.closest(LAYER_TREE_SELECTOR)))
}

function shouldIgnoreEditableTarget(commandId: string): boolean {
  const binding = KEYBINDINGS.find((kb) => kb.commandId === commandId)
  return binding?.ignoreInEditableField === true
}

export function findMatchingShortcutCommand(
  event: KeyboardEvent,
  context: CommandContext,
): Command | null {
  const commands = getAllCommands()

  for (const binding of KEYBINDINGS) {
    if (COMPONENT_OWNED_SHORTCUTS.has(binding.commandId)) continue
    if (binding.scope === 'canvas' && context.editor?.activeInlineEdit) continue
    if (binding.scope === 'canvas' && !isLayerShortcutSurface(event)) continue
    if (shouldIgnoreEditableTarget(binding.commandId) && isEditableShortcutTarget(event.target)) continue
    if (!binding.match(event as KeyEventLike)) continue

    const command = commands.find((candidate) => candidate.id === binding.commandId)
    if (!command) continue
    if (command.args && command.args.length > 0) continue
    if (command.destructive) continue
    if (filterCommands([command], context).length === 0) continue
    return command
  }

  return null
}
