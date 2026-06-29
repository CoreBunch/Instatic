/**
 * MCP tool registry — the full set of tools an external MCP client may use,
 * filtered to the connector's granted capabilities.
 *
 * Two execution classes are exposed:
 *   - server-resolved tools (content reads + `site_read_styles`) run in-process and
 *     work with NO editor open;
 *   - browser tools (structure edits, HTML/CSS authoring, design tokens, page
 *     lifecycle, content CRUD, code assets, live-DOM reads) are relayed to the
 *     connector owner's open editor via the live editor bridge
 *     (`./editorBridge`). If no editor is connected, the call returns a clear
 *     error telling the agent to open it.
 *
 * The editor's live store is the single source of truth: ALL page editing goes
 * through it (browser tools). There is deliberately no headless DB-mutating
 * page-tree tool — that created a second surface with identical node ids that
 * desynced from the open editor and got clobbered by its autosave.
 *
 * Capability filtering reuses the SAME gate the built-in agent uses
 * (`toolAllowedForCapabilities`): a connector without `ai.tools.write` never
 * sees a mutating tool, and a tool's `requiredCapabilities` (ANY-OF) must be
 * held. An MCP caller can never invoke a tool the granting capabilities
 * couldn't authorize over HTTP.
 */
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../runtime/types'
import { toolAllowedForCapabilities } from '../tools/capabilityGate'
import { contentTools } from '../tools/content'
import { siteTools } from '../tools/site'
import { styleMcpTools } from './tools/styleTools'
import { contextMcpTools } from './tools/contextTool'

// Server-resolved site read tools whose handlers read the browser-posted
// `ctx.snapshot`, which is null over MCP — they'd silently return nothing.
// `site_read_styles` (headless) replaces `site_list_tokens`. The snapshot-based
// `site_list_breakpoints` is excluded too; a headless `site_list_breakpoints` is provided
// by `styleMcpTools` (which is ordered first, so it wins the de-dup).
const MCP_EXCLUDED_TOOLS = new Set<string>(['site_list_tokens'])

function allMcpTools(): AiTool[] {
  // De-dup by tool name. Order matters: the headless style + content tools win
  // over the site toolset for any shared name (e.g. `list_documents`), so the
  // version that works without an open editor is the one exposed.
  const ordered = [...contextMcpTools, ...styleMcpTools, ...contentTools, ...siteTools]
  const byName = new Map<string, AiTool>()
  for (const tool of ordered) {
    if (MCP_EXCLUDED_TOOLS.has(tool.name)) continue
    if (!byName.has(tool.name)) byName.set(tool.name, tool)
  }
  return [...byName.values()]
}

export function mcpToolsForCapabilities(capabilities: readonly CoreCapability[]): AiTool[] {
  return allMcpTools().filter((t) => toolAllowedForCapabilities(t, capabilities))
}
