/**
 * Plugin settings endpoints.
 *
 *   GET /admin/api/cms/plugins/:id/settings — return masked settings (secret
 *                                              values become `'***'`)
 *   PUT /admin/api/cms/plugins/:id/settings — validate, then hand off to
 *                                              `persistAndSyncPluginSettings`,
 *                                              which persists, pushes the new
 *                                              record into the running VM, and
 *                                              fires `settings.changed`.
 */
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import { createAuditEvent } from '../../../repositories/audit'
import { getInstalledPlugin } from '../../../repositories/plugins'
import {
  validatePluginSettingsRecord,
  maskSecretSettings,
  resolveSecretSettingsUpdate,
  type PluginSettingsValues,
} from '@core/plugin-sdk'
import { persistAndSyncPluginSettings } from '../../../plugins/host/settingsSync'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestAuditContext } from '../shared'
import { pluginNotFound } from './shared'

export async function handlePluginSettings(
  req: Request,
  db: DbClient,
  user: AuthUser,
  pluginId: string,
): Promise<Response> {
  const result = await getInstalledPlugin(db, pluginId)
  if (!result) return pluginNotFound()
  if (result.kind === 'broken') {
    return jsonResponse(
      { error: 'Cannot manage settings for a plugin with a corrupt manifest — remove and reinstall it.' },
      { status: 409 },
    )
  }
  const plugin = result.plugin
  const declared = plugin.manifest.settings ?? []
  if (declared.length === 0) {
    return badRequest(`Plugin "${pluginId}" does not declare settings`)
  }

  if (req.method === 'GET') {
    return jsonResponse({
      schema: declared,
      settings: maskSecretSettings(declared, plugin.settings),
    })
  }

  if (req.method === 'PUT') {
    const PluginSettingsBodySchema = Type.Object({ settings: Type.Optional(Type.Unknown()) })
    const body = await readValidatedBody(req, PluginSettingsBodySchema)
    if (!body) return badRequest('Invalid request body')
    let cleaned: PluginSettingsValues
    try {
      cleaned = validatePluginSettingsRecord(declared, body.settings ?? body)
    } catch (err) {
      return badRequest(getErrorMessage(err, 'Invalid settings payload'))
    }
    // The admin form round-trips the masked GET payload, so an unchanged
    // secret comes back as the `'***'` sentinel — swap the stored real value
    // back in before persisting. An empty string still clears the secret.
    cleaned = resolveSecretSettingsUpdate(declared, cleaned, plugin.settings)
    // Persists, refreshes the host cache, pushes the merged record into the
    // plugin's running VM (no-op when it isn't loaded), then emits
    // `settings.changed` — in that order, so hook listeners reading
    // `api.cms.settings.get(...)` observe the new values.
    const merged = await persistAndSyncPluginSettings(db, pluginId, cleaned)
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'plugin.settings.update',
      targetType: 'plugin',
      targetId: pluginId,
      metadata: {
        pluginId,
        keys: Object.keys(cleaned),
      },
      ...requestAuditContext(req),
    })
    return jsonResponse({ settings: maskSecretSettings(declared, merged) })
  }

  return methodNotAllowed()
}
