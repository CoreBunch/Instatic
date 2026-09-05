/**
 * Plugin-scope tool barrel — exports the toolset, system-prompt builder,
 * and snapshot schema.
 *
 * The chat handler imports `pluginTools` for `scope === 'plugin'` and
 * `buildPluginSystemPrompt` when assembling the prompt for a plugin-scope
 * conversation. The MCP registry imports `pluginTools` too — file tools
 * relay to the open Plugin IDE; lifecycle tools run headless.
 */
import type { AiTool } from '../types'
import { pluginDocsTool } from './docs'
import { pluginFileTools, PLUGIN_FILE_READ_ONLY_NAMES } from './fileTools'
import {
  pluginLifecycleTools,
  PLUGIN_LIFECYCLE_READ_ONLY_NAMES,
} from './lifecycleTools'

// Stamp the `mutates` flag so `selectToolsForScope` can filter write tools
// out for callers without `ai.tools.write`. `plugin_open_file` counts as
// mutating (it moves the user's visible buffer — same policy as
// content_set_active_document).
export const pluginTools: AiTool[] = [
  { ...pluginDocsTool, mutates: false },
  ...pluginFileTools.map((t) => ({
    ...t,
    mutates: !PLUGIN_FILE_READ_ONLY_NAMES.has(t.name),
  })),
  ...pluginLifecycleTools.map((t) => ({
    ...t,
    mutates: !PLUGIN_LIFECYCLE_READ_ONLY_NAMES.has(t.name),
  })),
]

export { buildPluginSystemPrompt } from './systemPrompt'
// The snapshot schema lives in @core/ai so the IDE and the server derive
// the same type; re-exported here for the chat handler's scope wiring.
export { PluginIdeSnapshotSchema, emptyPluginIdeSnapshot } from '@core/ai'
export type { PluginIdeSnapshot } from '@core/ai'
