/**
 * Plugin-scope lifecycle tools — server-resolved.
 *
 * These run in-process (the build and the activation lifecycle are server
 * operations), which also makes them the plugin scope's headless MCP
 * surface: an external client can list/validate/activate without an open
 * IDE, following the `site_publish` precedent.
 *
 * `plugin_activate` deliberately cannot approve a grant-set change: the
 * permission review + step-up is a HUMAN consent moment (the IDE header
 * owns it). A grants-changed activation returns a clear instruction
 * instead. Same-grant rebuilds — the everyday agent loop of edit →
 * validate → activate — run without friction.
 *
 * The activation engine + list projection live with the site-plugins
 * handler module (`runSitePluginActivation`, `listSitePlugins`), which owns
 * that orchestration for every caller; these tools are thin adapters.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import { aiToolError, aiToolOk } from '@core/ai'
import {
  discoverSitePlugins,
  sitePluginIdFromLocalId,
} from '@core/site-plugins'
import type { AiTool } from '../types'
import type { ToolContext } from '../../runtime/types'
import {
  listSitePlugins,
  runSitePluginActivation,
} from '../../../handlers/cms/sitePlugins'
import { buildSitePlugin } from '../../../plugins/sitePlugins/build'
import { runPublishFlush } from '../../../publish/publishFlush'
import { getDraftSite } from '../../../repositories/site'
import { getInstalledPlugin } from '../../../repositories/plugins'
import { findUserById } from '../../../repositories/users'
import { PluginIdeSnapshotSchema } from './snapshot'
import { safeParseValue } from '@core/utils/typeboxHelpers'

const PLUGIN_READ_CAPS: readonly CoreCapability[] = ['site.read', 'plugins.read']

/**
 * `localId` is optional in the panel (defaults to the plugin open in the
 * IDE, from the snapshot) and required over MCP (snapshot is null there).
 */
const LocalIdInputSchema = Type.Object({
  localId: Type.Optional(Type.String({ minLength: 1 })),
})

function resolveLocalId(input: { localId?: string }, ctx: ToolContext): string | null {
  if (input.localId) return input.localId
  const parsed = safeParseValue(PluginIdeSnapshotSchema, ctx.snapshot)
  return parsed.ok && parsed.value.localId ? parsed.value.localId : null
}

const listPluginsTool: AiTool = {
  name: 'plugin_list_plugins',
  scope: 'plugin',
  execution: 'server',
  requiredCapabilities: PLUGIN_READ_CAPS,
  description:
    'List every site plugin (draft folders ∪ runtime rows) with its computed state, active version, declared vs granted permissions, and last runtime error. Use to orient before working on a plugin, or to find the localId for plugin_validate / plugin_activate.',
  inputSchema: Type.Object({}),
  handler: async (_input, ctx) => {
    return aiToolOk({ sitePlugins: await listSitePlugins(ctx.db) })
  },
}

const validateTool: AiTool = {
  name: 'plugin_validate',
  scope: 'plugin',
  execution: 'server',
  requiredCapabilities: PLUGIN_READ_CAPS,
  description:
    'Run the same validate-only build as the IDE diagnostics strip: TypeScript bundling, import containment, and manifest coherence. Returns { ok, diagnostics }. Iterate until diagnostics is empty before calling plugin_activate. Omit localId to validate the plugin open in the IDE.',
  inputSchema: LocalIdInputSchema,
  handler: async (input, ctx) => {
    const localId = resolveLocalId(input as { localId?: string }, ctx)
    if (!localId) {
      return aiToolError('No plugin in scope — pass localId (see plugin_list_plugins).')
    }
    await runPublishFlush()
    const shell = await getDraftSite(ctx.db)
    const draftFiles = shell?.files.filter((file) => file.type === 'plugin') ?? []
    const plugin = discoverSitePlugins(draftFiles).find((entry) => entry.localId === localId)
    if (!plugin) {
      return aiToolError(`No site plugin source at plugins/${localId}/`)
    }
    const rowResult = await getInstalledPlugin(ctx.db, sitePluginIdFromLocalId(localId))
    const row = rowResult?.kind === 'ok' ? rowResult.plugin : null
    const result = await buildSitePlugin({
      localId,
      files: plugin.files,
      previousVersion: row?.version ?? null,
      validateOnly: true,
    })
    return aiToolOk({ ok: result.ok, diagnostics: result.ok ? [] : result.diagnostics })
  },
}

const activateTool: AiTool = {
  name: 'plugin_activate',
  scope: 'plugin',
  execution: 'server',
  requiredCapabilities: ['plugins.install'],
  description:
    'Build & activate the plugin from the current draft source (install or upgrade, with publish coupling for visitor-facing surfaces). Same-grant rebuilds run directly; if the declared permission set CHANGED, activation is refused — a human must review and confirm the new grants in the IDE header (Build & activate). Run plugin_validate first. Omit localId to activate the plugin open in the IDE.',
  inputSchema: LocalIdInputSchema,
  handler: async (input, ctx) => {
    const localId = resolveLocalId(input as { localId?: string }, ctx)
    if (!localId) {
      return aiToolError('No plugin in scope — pass localId (see plugin_list_plugins).')
    }
    if (!ctx.uploadsDir) {
      return aiToolError('Uploads directory is not configured on this server.')
    }
    const user = await findUserById(ctx.db, ctx.userId)
    if (!user) return aiToolError('Calling user no longer exists.')

    const result = await runSitePluginActivation({
      db: ctx.db,
      options: { uploadsDir: ctx.uploadsDir },
      user,
      req: null,
      localId,
      allowGrantChange: false,
    })
    switch (result.status) {
      case 'ok':
        return aiToolOk({
          activated: !result.skipped,
          skipped: result.skipped,
          pluginId: result.plugin.id,
          version: result.plugin.version,
          ...(result.upgrade ? { upgrade: result.upgrade } : {}),
        })
      case 'grants-changed':
        return aiToolError(
          `Activation needs human consent: the permission grant set changed ` +
          `(new: ${result.newPermissions.join(', ') || 'none'}; removed: ${result.removedPermissions.join(', ') || 'none'}). ` +
          `Ask the user to click "Build & activate" in the Plugin IDE header to review and confirm the grants.`,
        )
      case 'build-failed':
        return aiToolError(
          `Build failed:\n${result.diagnostics.join('\n')}\nFix the diagnostics (plugin_validate) and retry.`,
        )
      case 'not-found':
      case 'invalid':
      case 'upgrade-error':
        return aiToolError(result.message)
    }
  },
}

export const pluginLifecycleTools: AiTool[] = [listPluginsTool, validateTool, activateTool]

/** Server tools that only read state. */
export const PLUGIN_LIFECYCLE_READ_ONLY_NAMES = new Set([
  'plugin_list_plugins',
  'plugin_validate',
])
