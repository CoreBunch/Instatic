/**
 * Tool registry root — selects the right toolset for a chat scope.
 *
 * Currently only the `site` scope has tools registered. Phase 4 will add
 * `content` + `data`; Phase 5 will add `plugin`.
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

function scopeToolset(scope: ToolScope): AiTool[] {
  switch (scope) {
    case 'site':
      return siteTools
    case 'content':
      return contentTools
    case 'data':
      // Phase 4 (data workspace)
      return []
    case 'plugin':
      // Phase 5
      return []
  }
}

/**
 * Returns the tools available for one chat scope, filtered against the
 * caller's capability set. The runtime hands this array to the driver
 * verbatim; drivers translate each `AiTool.inputSchema` (TypeBox) into
 * their SDK's native tool format.
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
): AiTool[] {
  return scopeToolset(scope).filter((t) => toolAllowedForCapabilities(t, capabilities))
}


