/**
 * get_context — orientation for an MCP agent in one call.
 *
 * Surfaces the two things that silently tripped up live use:
 *   1. which live workspaces are connected (browser tools need the matching
 *      Site or Content bridge), and
 *   2. which "everywhere" / post-type templates wrap pages (so the agent isn't
 *      surprised by a nav/footer it didn't author).
 *
 * Headless: editor presence comes from the bridge registry; templates + author
 * come straight from the DB. No browser snapshot.
 */
import { Type, type Static, safeParseValue } from '@core/utils/typeboxHelpers'
import { toolLocaleId } from '@core/ai'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool, ToolContext } from '../../runtime/types'
import { getDraftSite } from '../../../repositories/site'
import { listDataRows } from '../../../repositories/data'
import { listLocales, getDefaultLocale } from '../../../repositories/localization'
import { hasEditorBridge, getEditorBridgeLocale } from '../editorBridge'

const CONTEXT_READ_CAPS: readonly CoreCapability[] = [
  'site.read',
  'content.manage',
  'data.system.tables.read',
  'data.custom.tables.read',
  'pages.edit',
]

const GetContextInput = Type.Object(
  {
    localeId: Type.Optional(Type.String({ minLength: 1 })),
    entryId: Type.Optional(
      Type.String({ description: 'Optional page/post entry id — also reports whether a template wraps it.' }),
    ),
  },
  { additionalProperties: false },
)

export const contextMcpTools: AiTool[] = [
  {
    name: 'get_context',
    description:
      'Orient yourself before editing: reports whether the Site editor and Content workspace are connected (browser tools require their matching workspace), and which templates wrap pages — an "everywhere" template applies a nav/footer/etc. to every page, so anything you author is in addition to it. Pass entryId to also learn whether a template wraps that specific page. Headless — no editor needed. Call this first if a browser tool returns an "open the workspace" error.',
    scope: 'site',
    execution: 'server',
    inputSchema: GetContextInput,
    requiredCapabilities: CONTEXT_READ_CAPS,
    handler: async (input, ctx: ToolContext) => {
      const { entryId } = input as Static<typeof GetContextInput>
      const site = await getDraftSite(ctx.db)

      const locales = await listLocales(ctx.db)
      const localeId = toolLocaleId(input, ctx.snapshot) ?? (await getDefaultLocale(ctx.db)).id
      const rows = await listDataRows(ctx.db, 'pages', { localeId })
      const templates = rows
        .filter((r) => r.cells.templateEnabled === true)
        .map((r) => ({
          id: r.id,
          title: typeof r.cells.title === 'string' ? r.cells.title : r.id,
          target: readTemplate(r.cells.templateTarget).kind,
          tableSlugs: readTemplate(r.cells.templateTarget).tableSlugs,
          priority: typeof r.cells.templatePriority === 'number' ? r.cells.templatePriority : 100,
        }))
        .sort((a, b) => a.priority - b.priority)

      const result: Record<string, unknown> = {
        locales,
        localeId,
        site: site ? { name: site.name } : null,
        editor: {
          siteConnected: hasEditorBridge(ctx.userId, 'site'),
          contentConnected: hasEditorBridge(ctx.userId, 'content'),
          siteLocaleId: getEditorBridgeLocale(ctx.userId, 'site'),
          contentLocaleId: getEditorBridgeLocale(ctx.userId, 'content'),
        },
        templates,
      }

      if (entryId) {
        const entry = rows.find((r) => r.id === entryId)
        // `everywhere` templates wrap every page; that's the common surprise.
        const wrapping = templates.filter((t) => t.target === 'everywhere')
        result.page = {
          found: Boolean(entry),
          title: entry?.cells.title ?? null,
          wrappedByTemplates: wrapping.map((t) => t.title),
        }
      }

      return result
    },
  },
]

const TemplateTargetSchema = Type.Object({ kind: Type.String(), tableSlugs: Type.Optional(Type.Array(Type.String())) })
function readTemplate(value: unknown) {
  const parsed = safeParseValue(TemplateTargetSchema, value)
  return parsed.ok ? parsed.value : { kind: 'unknown', tableSlugs: undefined }
}
