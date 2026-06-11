/**
 * keybindings.ts — Unified keybindings registry (Phase 5).
 *
 * Single source of truth for every keyboard shortcut in the admin/editor.
 * Both the keyboard handlers (PanelRail, CanvasRoot, usePersistence,
 * SpotlightProvider, UndoRedoButtons) and the help screen (HelpKeybindingsList)
 * read exclusively from this registry.
 *
 * Shape:
 *   - commandId  → must match a spotlight Command id (or a virtual id for
 *                  bindings that don't map to a palette command, e.g. spotlight.open).
 *                  displayName is used as a fallback when no command is found.
 *   - shortcut   → { mac, win } display labels for UI hints and the help screen.
 *   - ariaKeyshortcuts → machine-readable ARIA attribute value (e.g. "Meta+I").
 *   - match      → predicate that tests a KeyboardEvent (or any KeyEventLike value).
 *   - scope      → where the binding is active:
 *                  'global'  = fires anywhere in the admin shell
 *                  'editor'  = fires within the editor workspace
 *                  'canvas'  = fires when the canvas element has focus
 *                  'panels'  = fires in the panel rail / sidebar region
 *   - ignoreInEditableField → advisory flag; handlers enforce this themselves.
 *
 * Adding a new shortcut:
 *   1. Add an entry to KEYBINDINGS below.
 *   2. Wire the match predicate in the appropriate handler (PanelRail, CanvasRoot, etc.).
 *   3. If the commandId doesn't exist yet, add it to the spotlight commands registry.
 *   4. Re-run the architecture test: bun test src/__tests__/architecture/keybindings-registry-single-source.test.ts
 */

import type { CommandId, CommandShortcut } from './types'

// ─── Key event shape ──────────────────────────────────────────────────────────
// Subset of KeyboardEvent that both native KeyboardEvent and React.KeyboardEvent<T>
// satisfy — allows match functions to be called from either context.

export interface KeyEventLike {
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly key: string
}

// ─── Binding definition ───────────────────────────────────────────────────────

export interface KeybindingDefinition {
  /**
   * Maps 1:1 to a Command id in the spotlight registry.
   * When no matching command exists (e.g. for 'spotlight.open' itself),
   * `displayName` is used as the fallback title in the help screen.
   */
  commandId: CommandId
  /** Fallback display title used in the help screen when no command matches commandId. */
  displayName?: string
  /** Human-readable shortcut labels rendered in the UI and help screen. */
  shortcut: CommandShortcut
  /**
   * Machine-readable ARIA keyshortcuts attribute value, e.g. "Meta+I".
   * Used on buttons that have an associated aria-keyshortcuts attribute.
   */
  ariaKeyshortcuts?: string
  /** Predicate that returns true when the event matches this binding. */
  match: (e: KeyEventLike) => boolean
  /** Activation scope — handlers gate firing based on this. */
  scope: 'global' | 'editor' | 'canvas' | 'panels'
  /**
   * When true, the binding should NOT fire when focus is inside an
   * input, textarea, or contenteditable. Handlers are responsible for
   * enforcing this — the flag is advisory/documentary.
   */
  ignoreInEditableField?: boolean
  /** Optional capability gate string (not enforced here — advisory only). */
  capability?: string
}

// ─── Platform detection ───────────────────────────────────────────────────────

/** Returns true when running on a macOS / iOS platform. */
export function isPlatformMac(): boolean {
  if (typeof navigator === 'undefined') return false
  // navigator.userAgentData.platform is the modern API (replaces navigator.platform)
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    ''
  return /Mac|iPhone|iPad|iPod/i.test(platform)
}

// ─── Format shortcut for display ─────────────────────────────────────────────

/**
 * Returns the platform-appropriate shortcut label from a CommandShortcut.
 * Used for button tooltips, aria-label, and help screen rows.
 */
export function formatShortcut(shortcut: CommandShortcut): string {
  return isPlatformMac() ? shortcut.mac : shortcut.win
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const KEYBINDINGS: ReadonlyArray<KeybindingDefinition> = [
  // ── Global ──────────────────────────────────────────────────────────────────

  {
    commandId: 'spotlight.open',
    displayName: 'Open Command Spotlight',
    shortcut: { mac: '⌘K', win: 'Ctrl+K' },
    match: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k',
    scope: 'global',
  },

  {
    commandId: 'editor.save',
    shortcut: { mac: '⌘S', win: 'Ctrl+S' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+S' : 'Control+S',
    match: (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's',
    scope: 'global',
  },

  {
    commandId: 'settings.open',
    shortcut: { mac: '⌘,', win: 'Ctrl+,' },
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === ',',
    scope: 'global',
  },

  {
    commandId: 'account.signOut',
    shortcut: { mac: '⌘⇧Q', win: 'Ctrl+Shift+Q' },
    match: (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'q',
    scope: 'global',
    ignoreInEditableField: true,
  },

  {
    commandId: 'help.shortcuts',
    shortcut: { mac: '?', win: '?' },
    match: (e) => e.key === '?' && !e.metaKey && !e.ctrlKey,
    scope: 'global',
    ignoreInEditableField: true,
  },

  // ── Editor (undo/redo — available in editor workspace) ───────────────────

  {
    commandId: 'editor.undo',
    shortcut: { mac: '⌘Z', win: 'Ctrl+Z' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+Z' : 'Control+Z',
    match: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z',
    scope: 'editor',
    ignoreInEditableField: true,
  },

  {
    commandId: 'editor.redo',
    shortcut: { mac: '⌘⇧Z', win: 'Ctrl+Shift+Z' },
    ariaKeyshortcuts: isPlatformMac() ? 'Meta+Shift+Z' : 'Control+Shift+Z',
    match: (e) =>
      (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && e.shiftKey,
    scope: 'editor',
    ignoreInEditableField: true,
  },

  // ── Panels (sidebar focus cycling) ──────────────────────────────────────────

  {
    commandId: 'panels.cycleFocus',
    shortcut: { mac: 'F6', win: 'F6' },
    match: (e) => e.key === 'F6',
    scope: 'panels',
  },

  // ── Canvas (layer operations — fire when canvas has focus) ──────────────────

  {
    commandId: 'layers.duplicate',
    shortcut: { mac: '⌘D', win: 'Ctrl+D' },
    match: (e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd',
    scope: 'canvas',
  },

  {
    commandId: 'layers.copy',
    shortcut: { mac: '⌘C', win: 'Ctrl+C' },
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === 'c',
    scope: 'canvas',
  },

  {
    commandId: 'layers.cut',
    shortcut: { mac: '⌘X', win: 'Ctrl+X' },
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === 'x',
    scope: 'canvas',
  },

  {
    commandId: 'layers.paste',
    shortcut: { mac: '⌘V', win: 'Ctrl+V' },
    match: (e) => (e.metaKey || e.ctrlKey) && e.key === 'v',
    scope: 'canvas',
  },

  {
    commandId: 'layers.delete',
    shortcut: { mac: 'Delete', win: 'Delete' },
    match: (e) => e.key === 'Delete' || e.key === 'Backspace',
    scope: 'canvas',
    ignoreInEditableField: true,
  },
]

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/** Map for O(1) lookup by commandId. Built once at module load time. */
const KEYBINDINGS_MAP = new Map<string, KeybindingDefinition>(
  KEYBINDINGS.map((kb) => [kb.commandId, kb]),
)

/**
 * Returns the keybinding for the given command id, or undefined if no binding
 * is registered for that command.
 */
export function getKeybindingForCommand(commandId: CommandId): KeybindingDefinition | undefined {
  return KEYBINDINGS_MAP.get(commandId)
}
