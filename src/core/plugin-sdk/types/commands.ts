// ---------------------------------------------------------------------------
// Editor commands, toolbar buttons, and Command Spotlight palette
// ---------------------------------------------------------------------------

export type PluginCommandResult = void | {
  message?: string
}

/**
 * A single argument collected from the user before running a palette command.
 * `type: 'text'` shows a free-form text input; `type: 'select'` renders a
 * static dropdown drawn from `options`.
 */
export interface PluginPaletteArg {
  id: string
  label: string
  type: 'text' | 'select'
  placeholder?: string
  options?: ReadonlyArray<{ value: string; label: string }>
}

/**
 * Core plugin command. All optional fields (subtitle, iconName, keywords,
 * shortcutLabel, destructive, args, workspaces) are palette-specific display
 * hints — omit them for a basic command that auto-surfaces with defaults.
 *
 * Registered via `api.editor.commands.register(cmd)` or
 * `api.editor.palette.registerCommand(cmd)` — both call the same underlying
 * runtime registration.
 */
export interface PluginCommand {
  id: string
  label: string
  run: () => PluginCommandResult | Promise<PluginCommandResult>
  /** Also show this direct command in the editable Site dock. Requires no arguments or confirmation. */
  showInSiteDock?: boolean
  /** Shown beneath the label in the palette result row. */
  subtitle?: string
  /** Pixel-art-icon name; falls back to a generic plug icon. */
  iconName?: string
  /** Extra search terms (low weight, used by the palette fuzzy matcher). */
  keywords?: string[]
  /**
   * Optional shortcut hint shown in the palette row.
   * NOT auto-bound — informational only in v1.
   */
  shortcutLabel?: string
  /** Mark destructive — palette renders danger styling + inline confirm. */
  destructive?: boolean
  /**
   * Declarative arguments collected in subcommand mode before the command
   * runs. Each arg is prompted in sequence.
   */
  args?: PluginPaletteArg[]
  /**
   * Workspace gate — palette hides this command unless the user is on one
   * of the listed workspaces. Omit (or include 'any') to show everywhere.
   */
  workspaces?: ReadonlyArray<
    'dashboard' | 'site' | 'content' | 'data' | 'media' | 'plugins' | 'users' | 'account' | 'any'
  >
}

/**
 * Type alias for clarity in contexts that explicitly document palette usage.
 * Structurally identical to `PluginCommand` — no separate interface needed
 * since every `PluginCommand` is a valid palette command.
 */
export type PluginPaletteCommand = PluginCommand

/**
 * A single result item returned by a `PluginPaletteProvider` search call.
 */
export interface PluginPaletteResult {
  id: string
  title: string
  subtitle?: string
  iconName?: string
  run: () => void | Promise<void>
}

/**
 * Live-search provider registered by a plugin via
 * `api.editor.palette.registerProvider(p)`. The host calls `search(query)`
 * on each debounced keystroke and surfaces the returned results in the
 * palette under the provider's `label` group.
 *
 * Provider id MUST be namespaced: `"<pluginId>.<name>"`.
 * Requires the `editor.commands` permission.
 */
export interface PluginPaletteProvider {
  /** Namespaced id: `"<pluginId>.<name>"`. Must be unique across all plugins. */
  id: string
  /** Becomes the group header in the palette result list. */
  label: string
  /**
   * Return up to ~25 results for the given query string. May be async.
   * Errors are caught by the host — a failing provider surfaces as an empty
   * group rather than crashing the palette.
   */
  search: (query: string) => Promise<PluginPaletteResult[]>
}

export interface PluginToolbarButton {
  id: string
  label: string
  command: string
}

export interface RegisteredPluginToolbarButton extends PluginToolbarButton {
  pluginId: string
}
