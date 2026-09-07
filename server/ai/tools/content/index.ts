/**
 * Content-scope tool barrel — exports the toolset, system-prompt builder,
 * and snapshot type.
 *
 * The chat handler imports `contentTools` for `scope === 'content'` and
 * `buildContentSystemPrompt` when assembling the prompt for a content-scope
 * conversation.
 */

import { selectLocaleTool, withBrowserLocaleContext } from '../localeTools'
import type { AiTool } from '../types'
import { contentReadTools } from './readTools'
import { contentWriteTools } from './writeTools'

// Stamp the `mutates` flag so `selectToolsForScope` can filter write tools
// out for callers without `ai.tools.write`. Read tools default to false.
export const contentTools: AiTool[] = [
  ...contentReadTools.map((t) => ({ ...t, mutates: false })),
  ...contentWriteTools.map((t) => ({ ...t, mutates: true })),
].map(withBrowserLocaleContext).concat(selectLocaleTool('content'))

export { buildContentSystemPrompt } from './systemPrompt'
export type { ContentSnapshot } from './snapshot'
