/**
 * Plugin settings handler — implements the `cms.settings.replace` api-call.
 *
 * Validates the incoming settings record against the plugin's declared
 * setting definitions, then hands off to `persistAndSyncPluginSettings`,
 * which persists, refreshes the host cache, pushes the merged record into
 * the running VM's `__plugin_settings` mirror, and emits `settings.changed`
 * (in that order — listeners reading `settings.get()` see the new values).
 * Because the push lands before the api-reply, the plugin's awaited
 * `settings.replace()` resolves with its mirror already updated.
 *
 * No permission gate — any active plugin may update its own settings.
 */

import { validatePluginSettingsRecord } from '@core/plugin-sdk'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiOk } from '../apiReplies'
import { persistAndSyncPluginSettings } from '../settingsSync'
import type { HostPluginRecord } from '../types'

export async function handleSettingsReplace(
  msg: ApiCallFor<'cms.settings.replace'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [next] = msg.args
  const cleaned = validatePluginSettingsRecord(entry.manifest.settings ?? [], next)
  const merged = await persistAndSyncPluginSettings(db, msg.pluginId, cleaned)
  replyApiOk(msg.pluginId, msg.correlationId, merged)
}
