/**
 * builtinCommands — the cached aggregation of every built-in spotlight
 * command, separated from `commandRegistry.ts` so scopes (`rootScope.ts`
 * etc.) can call `getAllCommands()` without re-importing the registry.
 *
 * Why this lives in its own file:
 *   - `commandRegistry.ts` statically imports every scope (so the scope
 *     registry can be built at module load).
 *   - `rootScope.ts` needs `getAllCommands` to populate its commands list.
 *   - If `getAllCommands` lived in `commandRegistry.ts`, those two files
 *     would form a static import cycle: registry imports rootScope,
 *     rootScope imports registry.
 *
 * Splitting the command aggregator out of the scope registry removes the
 * cycle. `commandRegistry.ts` still re-exports `getAllCommands` for the
 * rest of the spotlight surface; new callers should import from here.
 */

import type { Command } from './types'
import { getNavigationCommands } from './commands/navigation'
import { getAccountCommands } from './commands/account'
import { getEditorCommands } from './commands/editor'
import { getLayersCommands } from './commands/layers'
import { getPanelsCommands } from './commands/panels'
import { getSettingsCommands } from './commands/settings'
import { getHelpCommands } from './commands/help'
import { getPagesCommands } from './commands/pages'
import { getBreakpointsCommands } from './commands/breakpoints'
import { getContentCommands } from './commands/content'
import { getMediaCommands } from './commands/media'
import { getDataCommands } from './commands/data'
import { getFrameworkCommands } from './commands/framework'
import { getVisualComponentsCommands } from './commands/visualComponents'
import { getBuiltInPluginCommands, getPluginsCommands } from './commands/plugins'
import { getUsersCommands } from './commands/users'
import { getPreviewCommands } from './commands/preview'
import { getAiAssistantCommands } from './commands/aiAssistant'
import { getImportHtmlCommands } from './commands/importHtml'
import { getSiteImportCommands } from './commands/siteImport'
import { getSiteExportCommands } from './commands/siteExport'
import { getBranchesCommands } from './commands/branches'

/**
 * Module-level cache of the STATIC built-in command list. Each
 * `getXxxCommands()` factory creates fresh `Command` objects on every call;
 * caching the array here guarantees stable command references across renders.
 * Stable references are critical for `mergedFlatList.indexOf(cmd)` to work
 * in keyboard-navigation index tracking — without this, the highlighted row
 * tracking and `getCommandAtIndex` would never line up.
 *
 * Plugin commands are NOT cached here — `getPluginsCommands()` reads the
 * plugin runtime each call, so newly-registered plugins surface immediately
 * without a palette restart. The runtime maintains stable per-plugin command
 * references between registrations, so identity-based row matching still
 * works in practice (a plugin re-registering the same id during a session
 * is rare and would invalidate identity anyway).
 */
let CACHED_STATIC_COMMANDS: Command[] | null = null

/**
 * Returns all registered built-in commands plus the live plugin command set.
 * Static commands are computed once (stable references); plugin commands are
 * re-evaluated on every call so newly-installed plugins appear in the next
 * palette open without a refresh.
 */
export function getAllCommands(): Command[] {
  if (CACHED_STATIC_COMMANDS === null) {
    CACHED_STATIC_COMMANDS = [
      ...getNavigationCommands(),
      ...getEditorCommands(),
      ...getLayersCommands(),
      ...getPanelsCommands(),
      ...getPagesCommands(),
      ...getBreakpointsCommands(),
      ...getContentCommands(),
      ...getMediaCommands(),
      ...getDataCommands(),
      ...getFrameworkCommands(),
      ...getVisualComponentsCommands(),
      ...getBuiltInPluginCommands(),
      ...getUsersCommands(),
      ...getAccountCommands(),
      ...getSettingsCommands(),
      ...getPreviewCommands(),
      ...getImportHtmlCommands(),
      ...getSiteImportCommands(),
      ...getSiteExportCommands(),
      ...getBranchesCommands(),
      ...getAiAssistantCommands(),
      ...getHelpCommands(),
    ]
  }
  return [...CACHED_STATIC_COMMANDS, ...getPluginsCommands()]
}
