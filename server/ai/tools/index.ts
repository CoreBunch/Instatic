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
 * set and filters out tools tagged `mutates: true` for callers without
 * `ai.tools.write`. A `ai.chat`-only user (e.g. a Client persona that the
 * operator has granted chat but withheld write) cannot have the model
 * issue a write call — the write tools are never registered with the
 * driver in the first place.
 */

import type { CoreCapability } from '../../auth/capabilities'
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
 * Filtering rule: a caller without `ai.tools.write` does not see tools
 * tagged `mutates: true`. Read tools (`mutates: false` or undefined) are
 * always included.
 */
export function selectToolsForScope(
  scope: ToolScope,
  capabilities: readonly CoreCapability[],
): AiTool[] {
  const tools = scopeToolset(scope)
  if (capabilities.includes('ai.tools.write')) return tools
  return tools.filter((t) => !t.mutates)
}


