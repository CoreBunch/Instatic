/**
 * Spotlight type model — §3.3 of the Command Spotlight master plan.
 *
 * Central data model used by commandRegistry, matcher, state, and all
 * command/scope/provider definitions. No React imports here — pure types.
 */

import type { AdminWorkspace } from '@admin/workspace'
import type { CmsCurrentUser } from '@core/persistence'

// ─── Primitive identifiers ────────────────────────────────────────────────────

/** Dotted command identifier, e.g. "editor.duplicateLayer" */
export type CommandId = string

export type CommandGroup =
  | 'navigation'
  | 'editor'
  | 'pages'
  | 'content'
  | 'data'
  | 'media'
  | 'visualComponents'
  | 'framework'
  | 'plugins'
  | 'users'
  | 'account'
  | 'settings'
  | 'preview'
  | 'ai'
  | 'help'
  | 'recent'   // synthetic — only when query is empty
  | 'results'  // catch-all for provider-supplied jump items

// ─── Shortcut ─────────────────────────────────────────────────────────────────

export interface CommandShortcut {
  /** Mac order: ⌘ ⌥ ⌃ ⇧ + key. Auto-render Ctrl on non-Mac. */
  mac: string  // e.g. "⌘⇧K"
  win: string  // e.g. "Ctrl+Shift+K"
}

// ─── Argument ─────────────────────────────────────────────────────────────────

export interface CommandArg {
  id: string
  label: string
  type: 'text' | 'select' | 'pick'  // 'pick' = nested scope
  placeholder?: string
  required?: boolean
  /** For 'select' — static option list. For 'pick' — provider scope id. */
  options?: ReadonlyArray<{ value: string; label: string; sublabel?: string }>
  scope?: string  // for type: 'pick'
}

// ─── Command ──────────────────────────────────────────────────────────────────

/** Active document descriptor — which canvas document is currently open. */
type ActiveDocument =
  | { kind: 'page'; pageId: string }
  | { kind: 'visualComponent'; vcId: string }

/** Context snapshot built once per open, refreshed on selection change. */
export interface CommandContext {
  workspace: AdminWorkspace
  pathname: string
  user: CmsCurrentUser
  /** Live store reads — populated by the spotlight host when on site workspace. */
  editor?: {
    selectedNodeIds: ReadonlyArray<string>
    activePageId: string | null
    activeDocument: ActiveDocument | null
    canUndo: boolean
    canRedo: boolean
    activeBreakpointId: string
  }
}

/** Extended context passed into command.run() — adds action callbacks. */
export interface CommandRunContext extends CommandContext {
  /** Arguments collected via subcommand flow (Phase 2). */
  args: Record<string, string>
  navigate: (path: string) => void
  closeSpotlight: () => void
  pushScope: (scopeId: string, args?: Record<string, string>) => void
  popScope: () => void
  /**
   * Wrap a sensitive action with the step-up password re-entry flow.
   * Mirrors `useStepUp().runStepUp` — if the server rejects with
   * `step_up_required`, the StepUpProvider's dialog opens, and on a
   * successful re-auth the action is retried. On cancel it rejects with
   * `Error('step_up_cancelled')`. Spotlight commands that hit step-up-
   * gated endpoints (publish, plugin install, user delete, …) MUST wrap
   * their server call in this so the palette's UX matches the toolbar's.
   */
  runStepUp: <T>(action: () => Promise<T>) => Promise<T>
}

export interface Command {
  id: CommandId
  /** Primary label shown in the result row. */
  title: string
  /** Optional secondary line beneath the label. */
  subtitle?: string
  group: CommandGroup
  /** pixel-art-icons icon name, e.g. "save-solid". */
  iconName?: string
  /** Extra search terms (low weight, +40 per token). */
  keywords?: string[]
  // NOTE: shortcut hints are NOT stored on Command — they live in the keybindings
  // registry (src/admin/spotlight/keybindings.ts) and are looked up by commandId
  // at render time. See getKeybindingForCommand().
  /**
   * Capability gate — palette filters before display.
   *
   * Single string  → user must hold that capability.
   * String array   → user must hold at least one (any-of). Mirrors the
   *                  "any of these granular caps" pattern in `access.ts`
   *                  for content / users / etc.
   * Omitted        → no capability gate (workspace + when() may still hide).
   */
  capability?: string | readonly string[]
  /** Workspace gate — only show on these workspaces. 'any' = always. */
  workspaces?: ReadonlyArray<AdminWorkspace | 'any'>
  /** Predicate run at query time — finer-grained gating. */
  when?: (ctx: CommandContext) => boolean
  /** Boosts ranking when `when` returns true. Default 1.0. */
  priorityBoost?: number
  /** Arguments collected via subcommand flow (Phase 2). */
  args?: CommandArg[]
  /** Destructive — palette shows danger styling + inline confirm. */
  destructive?: boolean
  /** If true, palette stays open after run. */
  keepOpenAfterRun?: boolean
  /**
   * Run the command. May be sync, async, or return a scope push instruction.
   * Phase 2 fills in the scope-push path; Phase 1 commands are all void/Promise.
   */
  run: (ctx: CommandRunContext) => void | Promise<void> | { pushScope: string }
}

// ─── Scope ────────────────────────────────────────────────────────────────────

export interface SpotlightProvider {
  id: string
  /** Becomes the group header in results. */
  label: string
  /** Returns up to ~25 entries; can return [] cheaply. */
  search: (
    query: string,
    ctx: CommandContext,
    signal: AbortSignal,
  ) => Promise<Command[]> | Command[]
  /** Debounce in ms — applied per provider. 0 = synchronous each keystroke. */
  debounceMs?: number
}

export interface Scope {
  id: string         // 'root' | 'pages' | 'modules' | …
  title?: string     // header text in argument mode
  placeholder?: string
  /** Synchronous static commands offered by this scope. */
  commands: () => Command[]
  /** Async providers — called with debounced query + AbortSignal. */
  providers?: SpotlightProvider[]
}

// ─── Scope stack frame ────────────────────────────────────────────────────────

export interface ScopeFrame {
  scopeId: string
  /** Pending argument values collected so far. */
  pendingArgs: Record<string, string>
}
