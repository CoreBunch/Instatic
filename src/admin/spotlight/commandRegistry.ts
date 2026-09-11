/**
 * commandRegistry — aggregates all built-in spotlight commands and exposes
 * the search/run plumbing.
 *
 * Registers:
 *   - Built-in commands from each commands/ file
 *   - Built-in scope definitions from scopes/
 *   - Plugin palette providers (wrapped as SpotlightProviders)
 *
 * Design:
 *   - Module-level singleton (safe because this module is lazy-loaded
 *     only when the spotlight first opens)
 *   - Commands are filtered at search time by workspace, capability, and
 *     the `when()` predicate — not at registration time
 */

import type { Command, CommandContext, Scope, SpotlightProvider } from './types'
import { pluginRuntime } from '@core/plugins/runtime'

import { rootScope } from './scopes/rootScope'
import { editorScope } from './scopes/editorScope'
import { pagesScope } from './scopes/pagesScope'
import { breakpointsScope } from './scopes/breakpointsScope'
import { vcScope } from './scopes/vcScope'
import { contentScope } from './scopes/contentScope'
import { dataScope } from './scopes/dataScope'
import { mediaScope } from './scopes/mediaScope'
import { pluginsScope } from './scopes/pluginsScope'
import { usersScope } from './scopes/usersScope'
import { settingsScope } from './scopes/settingsScope'
import { helpScope } from './scopes/helpScope'
import { codeEditorScope } from './scopes/codeEditorScope'
import { pluginCommandsScope } from './scopes/pluginCommandsScope'

// ─── Scope registry ───────────────────────────────────────────────────────────

const SCOPE_REGISTRY: Map<string, Scope> = new Map([
  ['root', rootScope],
  ['editor', editorScope],
  ['pages', pagesScope],
  ['breakpoints', breakpointsScope],
  ['visualComponents', vcScope],
  ['content', contentScope],
  ['data', dataScope],
  ['media', mediaScope],
  ['plugins', pluginsScope],
  ['users', usersScope],
  ['settings', settingsScope],
  ['help', helpScope],
  ['codeEditor', codeEditorScope],
  ['pluginCommands', pluginCommandsScope],
])

export function getScope(id: string): Scope | undefined {
  return SCOPE_REGISTRY.get(id)
}

// ─── Built-in commands ────────────────────────────────────────────────────────

// `getAllCommands` lives in `builtinCommands.ts` so scopes (like `rootScope`)
// can import it without re-entering this registry — see that file's header.
export { getAllCommands } from './builtinCommands'

/**
 * Filter commands by the current workspace, capability, and when() predicate.
 * Excludes commands explicitly gated to a different workspace (unless 'any').
 *
 * Three gates, evaluated in order:
 *   1. workspaces  — if the command names a workspace list, the active
 *                    workspace must be in it (or 'any' must be present).
 *   2. capability  — the user must hold at least one of the named capabilities.
 *                    Accepts either a single string or a readonly string[]
 *                    (interpreted as "any of"). Mirrors the way access.ts
 *                    expresses workspace access — single caps for simple gates,
 *                    arrays for "any of these granular caps."
 *   3. when()      — pure predicate evaluated against the live context.
 *                    Returning false (or throwing) hides the command.
 *                    Throws are swallowed and treated as "hide" so a misbehaving
 *                    predicate can never crash the palette.
 *
 * The matcher independently re-evaluates when() for its +250 score boost — the
 * predicate is required to be pure (no side effects), so the double call is
 * cheap and correct.
 */
export function filterCommands(commands: Command[], ctx: CommandContext): Command[] {
  return commands.filter((cmd) => {
    // Workspace gate
    if (cmd.workspaces && cmd.workspaces.length > 0) {
      if (
        !cmd.workspaces.includes('any') &&
        !cmd.workspaces.includes(ctx.workspace)
      ) {
        return false
      }
    }

    // Capability gate — user must hold at least one of the named capabilities.
    if (cmd.capability) {
      const required = Array.isArray(cmd.capability) ? cmd.capability : [cmd.capability]
      if (required.length > 0 && !required.some((c) => ctx.user.capabilities.includes(c))) {
        return false
      }
    }

    // available() — does this command exist in this environment at all?
    // Unlike when(), it carries no relevance claim and never scores.
    if (cmd.available) {
      try {
        if (!cmd.available(ctx)) return false
      } catch (_err) {
        return false
      }
    }

    // when() predicate — false (or thrown) means "hide this command."
    if (cmd.when) {
      try {
        if (!cmd.when(ctx)) return false
      } catch (_err) {
        return false
      }
    }

    return true
  })
}

// ─── Plugin palette providers ─────────────────────────────────────────────────

/**
 * Returns all plugin-registered `PluginPaletteProvider`s wrapped as
 * `SpotlightProvider` objects ready for the `ProviderRunner`.
 *
 * Each provider:
 *   - Gets a stable id scoped to the plugin: `"plugin:<pluginId>:<providerId>"`
 *   - Uses the plugin provider's label as the result group header
 *   - Wraps `search` in a try/catch — errors are logged and surface as an
 *     empty group rather than crashing the palette
 *   - Respects the AbortSignal: results are discarded if the signal fired
 *     while the plugin provider's async search was in-flight
 *
 * Called by `ProviderRunner.run()` on each keystroke to obtain the current
 * set of plugin providers (handles plugins that register providers after
 * the palette was first opened).
 */
export function getPluginPaletteSpotlightProviders(): SpotlightProvider[] {
  return pluginRuntime.getPaletteProviders().map((registered): SpotlightProvider => {
    const { pluginId, id: providerId, label, search } = registered

    return {
      id: `plugin:${pluginId}:${providerId}`,
      label,
      debounceMs: 150,

      async search(query, _ctx, signal): Promise<Command[]> {
        let rawResults
        try {
          rawResults = await search(query)
        } catch (err) {
          console.error(
            `[spotlight:plugin:${pluginId}] provider "${providerId}" search failed:`,
            err,
          )
          return []
        }

        // Discard results if aborted while the plugin's async call was in-flight.
        if (signal.aborted) return []

        return rawResults.map((r): Command => ({
          id: `plugin:${pluginId}:${providerId}:${r.id}`,
          title: r.title,
          subtitle: r.subtitle,
          iconName: r.iconName ?? 'plug',
          group: 'plugins',
          run: async (ctx) => {
            ctx.closeSpotlight()
            try {
              await r.run()
            } catch (err) {
              console.error(
                `[spotlight:plugin:${pluginId}] provider result "${r.id}" run failed:`,
                err,
              )
            }
          },
        }))
      },
    }
  })
}
