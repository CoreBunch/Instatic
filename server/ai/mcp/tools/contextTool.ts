/**
 * get_context — orientation for an MCP agent in one call.
 *
 * Surfaces the two things that silently tripped up live use:
 *   1. which live workspaces are connected (browser tools need the matching
 *      Site or Content bridge), and
 *   2. which "everywhere" / post-type templates wrap pages (so the agent isn't
 *      surprised by a nav/footer it didn't author).
 *
 * Headless: editor presence is a live probe through each registered bridge
 * (`pingEditorBridge`); templates + author come straight from the DB. No
 * browser snapshot.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool, ToolContext } from '../../runtime/types'
import { getDraftSite } from '../../../repositories/site'
import { pingEditorBridge, type EditorBridgeScope } from '../editorBridge'

const CONTEXT_READ_CAPS: readonly CoreCapability[] = [
  'site.read',
  'content.manage',
  'data.system.tables.read',
  'data.custom.tables.read',
  'pages.edit',
]

const GetContextInput = Type.Object(
  {
    entryId: Type.Optional(
      Type.String({ description: 'Optional page/post entry id — also reports whether a template wraps it.' }),
    ),
  },
  { additionalProperties: false },
)

interface PageCells {
  title?: string
  templateEnabled?: boolean
  templateTarget?: { kind?: string; tableSlugs?: string[] }
  templatePriority?: number
}

interface PageRow {
  id: string
  table_id: string
  cells_json: PageCells
}

export const contextMcpTools: AiTool[] = [
  {
    name: 'get_context',
    description:
      'Orient yourself before editing: reports whether the Site editor and Content workspace are connected (browser tools require their matching workspace), and which templates wrap pages — an "everywhere" template applies a nav/footer/etc. to every page, so anything you author is in addition to it. `siteConnected` / `contentConnected` are live: true only when that open tab answered a probe just now. `unresponsive` lists workspaces whose tab opened a bridge but did not answer — that tab is stuck or its connection died, relayed tools to it will time out, and the fix is to reload that tab, not to retry. Pass entryId to also learn whether a template wraps that specific page. Headless — no editor needed. Call this first if a browser tool returns an "open the workspace" error or times out.',
    scope: 'site',
    execution: 'server',
    inputSchema: GetContextInput,
    requiredCapabilities: CONTEXT_READ_CAPS,
    handler: async (input, ctx: ToolContext) => {
      const { entryId } = input as { entryId?: string }
      const site = await getDraftSite(ctx.db)

      const { rows } = await ctx.db<PageRow>`
        select id, table_id, cells_json
        from data_rows
        where table_id = 'pages' and deleted_at is null
      `
      const templates = rows
        .filter((r) => r.cells_json?.templateEnabled)
        .map((r) => ({
          id: r.id,
          title: r.cells_json.title ?? r.id,
          target: r.cells_json.templateTarget?.kind ?? 'unknown',
          tableSlugs: r.cells_json.templateTarget?.tableSlugs,
          priority: r.cells_json.templatePriority ?? 100,
        }))
        .sort((a, b) => a.priority - b.priority)

      // Probe both workspaces for real rather than reading the registry: an
      // entry whose tab stopped answering read as "connected" for as long as
      // the idle lease kept it, which sent callers chasing their own inputs
      // while every relayed tool timed out (#490).
      const [siteLiveness, contentLiveness] = await Promise.all([
        pingEditorBridge(ctx.userId, 'site'),
        pingEditorBridge(ctx.userId, 'content'),
      ])
      const unresponsive: EditorBridgeScope[] = []
      if (siteLiveness === 'unresponsive') unresponsive.push('site')
      if (contentLiveness === 'unresponsive') unresponsive.push('content')

      const result: Record<string, unknown> = {
        site: site ? { name: site.name } : null,
        editor: {
          siteConnected: siteLiveness === 'live',
          contentConnected: contentLiveness === 'live',
          unresponsive,
        },
        templates,
      }

      if (entryId) {
        const entry = rows.find((r) => r.id === entryId)
        // `everywhere` templates wrap every page; that's the common surprise.
        const wrapping = templates.filter((t) => t.target === 'everywhere')
        result.page = {
          found: Boolean(entry),
          title: entry?.cells_json.title ?? null,
          wrappedByTemplates: wrapping.map((t) => t.title),
        }
      }

      return result
    },
  },
]
