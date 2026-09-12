/**
 * Plugin-IDE agent-slice config — supplied to `createAgentSlice` when the
 * IDE's standalone Zustand store is composed.
 *
 * Mirrors `agentSliceConfig.content.ts`:
 *   - declares `scope: 'plugin'` for URL + JSON wiring,
 *   - snapshots the live IDE (open plugin, files, runtime state) via the
 *     registered PluginIdeBridgeHandle,
 *   - dispatches browser tools through `executePluginTool`,
 *   - points the no-provider error at the "plugin" scope default.
 */
import type { AgentSliceConfig } from '@site/agent'
import { executePluginTool } from './pluginBridge'
import { emptyPluginIdeSnapshot, getPluginIdeBridgeHandle } from './pluginBridgeHandle'

export const pluginAgentSliceConfig: AgentSliceConfig = {
  scope: 'plugin',
  buildSnapshot: () =>
    getPluginIdeBridgeHandle()?.buildSnapshot() ?? emptyPluginIdeSnapshot(),
  dispatchTool: executePluginTool,
  noProviderMessage:
    'No AI provider configured for the Plugin IDE. Open /admin/ai/providers to add a credential, then /admin/ai/defaults to pick one for the "plugin" scope.',
}
