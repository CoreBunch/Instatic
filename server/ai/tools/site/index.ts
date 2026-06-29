/**
 * Site-scope tool barrel — exports the toolset and the system prompt builder.
 *
 * The chat handler imports `siteTools` for `scope === 'site'` and
 * `buildSiteSystemPrompt` when assembling the prompt for a site-scope
 * conversation.
 *
 * Write tools (everything in `siteWriteTools` except browser-backed reads) are
 * stamped `mutates: true` so `selectToolsForScope` can filter them out for
 * callers without `ai.tools.write`.
 */

import type { AiTool } from '../types'
import { siteReadTools } from './readTools'
import { siteWriteTools } from './writeTools'

const READ_ONLY_NAMES_IN_WRITE_FILE = new Set([
  'site_get_node_html',
  'site_read_document',
  'site_open_document',
  'site_list_code_assets',
  'site_read_code_asset',
  'site_inspect_code_runtime',
  'site_render_snapshot',
])

function stampMutationFlag(tools: AiTool[], isMutating: boolean): AiTool[] {
  return tools.map((t) => {
    // Some browser-backed tools live in writeTools.ts for bridge dispatch but
    // do not change site content — exclude them from the mutating stamp.
    const mutates = isMutating && !READ_ONLY_NAMES_IN_WRITE_FILE.has(t.name)
    return { ...t, mutates }
  })
}

export const siteTools: AiTool[] = [
  ...stampMutationFlag(siteReadTools, false),
  ...stampMutationFlag(siteWriteTools, true),
]

export { buildSiteSystemPrompt } from './systemPrompt'
export { SiteAgentSnapshotSchema } from './snapshot'
export type { SiteAgentSnapshot } from './snapshot'
