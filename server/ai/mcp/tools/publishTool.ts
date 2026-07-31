/**
 * Explicit full-site publish tool for MCP connectors.
 *
 * Site editing tools write the live editor draft and the browser bridge flushes
 * that draft before returning. Publishing stays a separate operation so a
 * multi-tool edit cannot leak half-finished work to visitors. A connector that
 * was explicitly granted `pages.publish` can call this server-side tool after
 * its edit sequence is complete; the canonical publish pipeline rebuilds the
 * static slot, swaps it atomically, and bumps the in-memory publish version.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool, ToolContext } from '../../runtime/types'
import { createAuditEvent } from '../../../repositories/audit'
import { publishDraftSite } from '../../../publish/publishSite'

export interface McpPublishRuntime {
  connectorId: string
  uploadsDir: string
}

export function createPublishMcpTool(runtime?: McpPublishRuntime): AiTool {
  return {
    name: 'site_publish',
    description:
      'Publish the saved site draft to the live public site. Call this ONCE after the requested site edits are complete — site_insert_html, site_apply_css, token tools, and other site writes save a draft and deliberately do not publish on their own. This runs the full-site publish pipeline, rebuilding content-hashed HTML/CSS/runtime assets and atomically swapping the public static slot. Requires the connector to have pages.publish.',
    scope: 'site',
    execution: 'server',
    mutates: true,
    requiredCapabilities: ['pages.publish'],
    inputSchema: Type.Object({}, { additionalProperties: false }),
    handler: async (_input, ctx: ToolContext) => {
      if (!runtime) {
        throw new Error('MCP publish runtime uploads directory is not configured.')
      }

      const result = await publishDraftSite(ctx.db, ctx.userId, runtime.uploadsDir)
      await createAuditEvent(ctx.db, {
        actorUserId: ctx.userId,
        action: 'publish',
        targetType: 'site',
        targetId: 'default',
        metadata: {
          publishedPages: result.publishedPages,
          source: 'mcp',
          connectorId: runtime.connectorId,
        },
      })
      return result
    },
  }
}
