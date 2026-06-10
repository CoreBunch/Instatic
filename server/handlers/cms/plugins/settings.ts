/**
 * Plugin settings endpoints.
 *
 *   GET /admin/api/cms/plugins/:id/settings — return the declared schema +
 *       presented values. Secret fields surface only presence: `'***'` when
 *       an encrypted row exists, `''` when not. Fields whose stored row was
 *       encrypted with a different master key are listed in
 *       `secretsNeedingReentry` so the form can prompt for re-entry.
 *   PUT /admin/api/cms/plugins/:id/settings — validate, then hand off to
 *       `persistAndSyncPluginSettings`, which persists (secret fields split
 *       into the encrypted `plugin_secrets` table: `'***'` preserves, a new
 *       value rotates, `''` clears), refreshes the runtime cache, pushes the
 *       decrypted runtime record into the running VM, and fires
 *       `settings.changed` so plugin server hooks see real values.
 */
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import { createAuditEvent } from '../../../repositories/audit'
import { getInstalledPlugin } from '../../../repositories/plugins'
import {
  listPluginSecretStates,
  PluginSecretError,
} from '../../../repositories/pluginSecrets'
import { validatePluginSettingsRecord, type PluginSettingsValues } from '@core/plugin-sdk'
import { persistAndSyncPluginSettings } from '../../../plugins/host/settingsSync'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestAuditContext } from '../shared'
import { pluginNotFound, projectSecretSettings } from './shared'

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
    const states = await listPluginSecretStates(db, pluginId)
    return jsonResponse({
      schema: declared,
      settings: projectSecretSettings(declared, plugin.settings, states),
      secretsNeedingReentry: secretsNeedingReentry(states),
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
    // Persist through the split choke point: secret fields go encrypted to
    // `plugin_secrets` (the `'***'` sentinel the form round-trips preserves
    // the stored row, an empty string clears it), the rest to settings_json.
    // `persistAndSyncPluginSettings` then refreshes the runtime cache
    // (decrypted secrets merged), pushes the record into the plugin's
    // running VM (no-op when it isn't loaded), and emits `settings.changed`
    // — in that order, so hook listeners reading `api.cms.settings.get(...)`
    // observe the new values.
    let runtimeSettings: PluginSettingsValues
    try {
      runtimeSettings = await persistAndSyncPluginSettings(db, pluginId, declared, cleaned)
    } catch (err) {
      if (err instanceof PluginSecretError) {
        return jsonResponse({ error: err.message }, { status: err.status })
      }
      throw err
    }
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
    const states = await listPluginSecretStates(db, pluginId)
    // Projection overrides every secret field with `'***'`/`''`, so the
    // runtime record's decrypted values never reach the response.
    return jsonResponse({
      settings: projectSecretSettings(declared, runtimeSettings, states),
      secretsNeedingReentry: secretsNeedingReentry(states),
    })
  }

  return methodNotAllowed()
}

function secretsNeedingReentry(
  states: Awaited<ReturnType<typeof listPluginSecretStates>>,
): string[] {
  return states.filter((s) => !s.keyFingerprintCurrent).map((s) => s.settingId)
}
