/**
 * Data-scope tool barrel.
 *
 * Everything here is `execution: 'server'` and works with no workspace tab
 * open, which is the point: reusable data tables are edited in a grid, not in
 * the Tiptap editor that forces the `content_*` writes through the browser
 * bridge. See `schemaTools.ts` for the full reasoning and the step-up caveat.
 *
 * A factory, not a constant, because the row tools need per-connection context
 * (`DataToolsRuntime`): the uploads directory both callers supply, plus the
 * connector id only the MCP server has. Calling it with no argument leaves the
 * artefact writes off, which is correct only where nothing is ever published —
 * both live callers pass an uploads dir.
 */

import type { AiTool } from '../types'
import { dataLifecycleTools } from './lifecycleTools'
import { dataRowTools } from './rowTools'
import { dataSchemaTools } from './schemaTools'
import type { DataToolsRuntime } from './runtime'

export function dataTools(runtime?: DataToolsRuntime): AiTool[] {
  return [
    ...dataSchemaTools(runtime),
    ...dataRowTools(runtime),
    ...dataLifecycleTools(runtime),
  ]
}

export type { DataToolsRuntime } from './runtime'
