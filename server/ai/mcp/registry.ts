/**
 * MCP tool registry — the full set of tools an external MCP client may use,
 * filtered to the connector's granted capabilities.
 *
 * Two execution classes are exposed:
 *   - server-resolved tools (content reads + `site_list_documents` +
 *     `site_read_styles`) run in-process and work with NO editor open;
 *   - browser tools (structure edits, HTML/CSS authoring, design tokens, page
 *     lifecycle, content CRUD, code assets, live-DOM reads) are relayed to the
 *     connector owner's matching open Site or Content workspace via the live
 *     editor bridge (`./editorBridge`). If that workspace is not connected,
 *     the call returns a clear scope-specific error.
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
import { documentMcpTools } from './tools/documentTools'
import { createPublishMcpTool, type McpPublishRuntime } from './tools/publishTool'

// Server-resolved site read tools whose handlers read the browser-posted
// `ctx.snapshot`, which is null over MCP — they'd return nothing or throw.
// Each is handled one of two ways:
//   - `site_list_tokens` → excluded; `site_read_styles` (headless) replaces it.
//   - `site_list_breakpoints` → shadowed by a headless version in `styleMcpTools`.
//   - `site_list_documents` → shadowed by a headless version in `documentMcpTools`
//     (the snapshot-based one throws on `null.currentDocument`).
// The headless tool sets are ordered ahead of `siteTools` below, so they win
// the de-dup for any shared name.
const MCP_EXCLUDED_TOOLS = new Set<string>(['site_list_tokens'])

function allMcpTools(runtime?: McpPublishRuntime): AiTool[] {
  // De-dup by tool name. Order matters: the headless MCP-specific + content
  // tools win over the site toolset for shared names, so the version that works
  // without an open editor is the one exposed.
  const ordered = [
    ...contextMcpTools,
    ...styleMcpTools,
    ...documentMcpTools,
    createPublishMcpTool(runtime),
    ...contentTools,
    ...siteTools,
  ]
  const byName = new Map<string, AiTool>()
  for (const tool of ordered) {
    if (MCP_EXCLUDED_TOOLS.has(tool.name)) continue
    if (!byName.has(tool.name)) byName.set(tool.name, tool)
  }
  return [...byName.values()]
}

export function mcpToolsForCapabilities(
  capabilities: readonly CoreCapability[],
  runtime?: McpPublishRuntime,
): AiTool[] {
  return allMcpTools(runtime).filter((t) => toolAllowedForCapabilities(t, capabilities))
}
