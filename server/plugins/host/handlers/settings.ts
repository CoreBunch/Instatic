/**
 * Plugin settings handler — implements the `cms.settings.replace` api-call.
 *
 * Validates the incoming settings record against the plugin's declared
 * setting definitions, then hands off to `persistAndSyncPluginSettings` —
 * the same split choke point as the admin PUT route (secret fields go
 * encrypted to `plugin_secrets`, everything else to `settings_json`) —
 * which refreshes the host cache, pushes the merged runtime record into
 * the running VM's `__plugin_settings` mirror, and emits `settings.changed`
 * (in that order — listeners reading `settings.get()` see the new values).
 * Because the push lands before the api-reply, the plugin's awaited
 * `settings.replace()` resolves with its mirror already updated.
 *
 * The reply value — which also seeds the worker's local mirror — is the
 * runtime record with decrypted secrets merged back in. It travels
 * host → worker only, never to a browser.
 *
 * No permission gate — any active plugin may update its own settings.
 */

import { validatePluginSettingsRecord, type PluginSettingsValues } from '@core/plugin-sdk'
import { PluginSecretError } from '../../../repositories/pluginSecrets'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiError, replyApiOk } from '../apiReplies'
import { persistAndSyncPluginSettings } from '../settingsSync'
import type { HostPluginRecord } from '../types'

export async function handleSettingsReplace(
  msg: ApiCallFor<'cms.settings.replace'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [next] = msg.args
  const declared = entry.manifest.settings ?? []
  const cleaned = validatePluginSettingsRecord(declared, next)
  let runtimeSettings: PluginSettingsValues
  try {
    runtimeSettings = await persistAndSyncPluginSettings(db, msg.pluginId, declared, cleaned)
  } catch (err) {
    if (err instanceof PluginSecretError) {
      replyApiError(msg.pluginId, msg.correlationId, err.message)
      return
    }
    throw err
  }
  replyApiOk(msg.pluginId, msg.correlationId, runtimeSettings)
}
