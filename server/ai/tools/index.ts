/**
 * Tool registry root — selects the right toolset for a chat scope.
 *
 * `site`, `content`, and `data` scopes have tools registered. `plugin` is a
 * reserved scope with no toolset yet.
 *
 * Adding a new scope:
 *   1. Create `server/ai/tools/<scope>/` with its tool files + index.ts.
 *   2. Import its barrel here.
 *   3. Add a switch arm in `scopeToolset`.
 *   4. The `ai-tools-typebox-only.test.ts` gate ensures every file under
 *      `server/ai/tools/**` uses TypeBox (not Zod) — covered automatically.
 *
 * Capability filtering: `selectToolsForScope` takes the caller's capability
 * set and filters through `toolAllowedForCapabilities` — write tools need
 * `ai.tools.write`, and any tool declaring `requiredCapabilities` (ANY-OF,
 * mirroring its HTTP-route equivalent) is only offered to callers holding
 * one. A `ai.chat`-only user (e.g. a Client persona granted chat) cannot
 * have the model issue a call the user couldn't make over HTTP — gated
 * tools are never registered with the driver in the first place.
 */

import type { CoreCapability } from '../../auth/capabilities'
import { toolAllowedForCapabilities } from './capabilityGate'
import type { AiTool, ToolScope } from './types'
import { siteTools } from './site'
import { contentTools } from './content'
import { tableScopedReadTools } from './content/readTools'
import { dataTools } from './data'

/**
 * Per-request context the toolset needs from the server runtime. `uploadsDir`
 * is what lets a data row's baked artefact be written and unlinked — without
 * it a retract or delete from the in-app Data chat would leave the published
 * HTML on disk, still served by Layer A.
 */
export interface ToolsetOptions {
  uploadsDir?: string
}

function scopeToolset(scope: ToolScope, options: ToolsetOptions = {}): AiTool[] {
  switch (scope) {
    case 'site':
      return siteTools
    case 'content':
      return contentTools
    case 'data':
      // Schema + row tools, all server-resolved. The MCP registry builds its
      // own copy with a connector-attributed runtime (see
      // server/ai/mcp/registry.ts); the in-app agent gets the same tools with
      // an uploads dir but no connector id, so its writes audit as
      // `source: 'agent'`.
      //
      // `dataTools()` writes rows but cannot read one back, so the three
      // table-scoped content reads come along — they resolve a reusable data
      // table's id just as they resolve a post type's. Without them an agent
      // in the Data workspace could create a table and fill it, then have no
      // way to see what it wrote.
      return [
        ...dataTools(options.uploadsDir ? { uploadsDir: options.uploadsDir } : undefined),
        ...tableScopedReadTools.map((t) => ({ ...t, mutates: false })),
      ]
    case 'plugin':
      // Reserved: no plugin-scope toolset yet.
      return []
  }
}

/**
 * Returns the tools available for one chat scope, filtered against the
 * caller's capability set. The runtime hands this array to the driver
 * verbatim; drivers translate each `AiTool.inputSchema` (TypeBox) into
 * the provider-native tool format.
 *
 * Filtering (see `toolAllowedForCapabilities`, the single gate):
 *   - a caller without `ai.tools.write` does not see tools tagged
 *     `mutates: true`;
 *   - a tool with `requiredCapabilities` (ANY-OF) is only offered to
 *     callers holding at least one of them — the agent inherits the
 *     caller's capabilities by construction instead of `ai.chat` acting
 *     as a blanket read grant.
 */
export function selectToolsForScope(
  scope: ToolScope,
  capabilities: readonly CoreCapability[],
  options: ToolsetOptions = {},
): AiTool[] {
  return scopeToolset(scope, options).filter((t) => toolAllowedForCapabilities(t, capabilities))
}
