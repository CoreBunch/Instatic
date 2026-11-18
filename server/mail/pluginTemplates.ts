/**
 * A plugin's email templates in the catalogue, and what is left of a
 * plugin's email when it is uninstalled.
 *
 * Templates are in the catalogue exactly while the plugin's server code is
 * loaded: registered when it loads (install, enable, upgrade, restart,
 * boot), taken out when it unloads. The owner's edits live in
 * `mail_templates` under the same keys, so they survive every unload and an
 * upgrade, and go only when the plugin is uninstalled.
 */
import {
  listMailTemplateDefinitions,
  registerMailTemplate,
  unregisterMailTemplate,
} from '@core/mail'
import type { PluginManifest } from '@core/plugin-sdk'
import { pluginMailTemplateDefinitions, pluginMailTemplatePrefix } from '@core/plugins/manifestMail'
import type { DbClient } from '../db/client'
import { updateMailProgress } from './activity'
import { clearMailCounters } from './limits'

/** A plugin template key is `plugin.<pluginId>~<key>`; nothing else in the catalogue contains `~`. */
const PLUGIN_KEY_MARK = '~'

function unregisterWhere(belongs: (key: string) => boolean): void {
  for (const definition of listMailTemplateDefinitions()) {
    if (belongs(definition.key)) unregisterMailTemplate(definition.key)
  }
}

function unregisterByPrefix(prefix: string): void {
  unregisterWhere((key) => key.startsWith(prefix))
}

/** Put a loaded plugin's templates in the catalogue, replacing the ones it had. */
export function registerPluginMailTemplates(manifest: Pick<PluginManifest, 'id' | 'name' | 'mail'>): void {
  unregisterByPrefix(pluginMailTemplatePrefix(manifest.id))
  for (const definition of pluginMailTemplateDefinitions(manifest)) registerMailTemplate(definition)
}

export function unregisterPluginMailTemplates(pluginId: string): void {
  unregisterByPrefix(pluginMailTemplatePrefix(pluginId))
}

/** Forget every plugin's templates: the plugin runtime is starting from a clean slate. */
export function unregisterAllPluginMailTemplates(): void {
  unregisterWhere((key) => key.includes(PLUGIN_KEY_MARK))
}

/**
 * An uninstalled plugin leaves no email behind: the owner's edits of its
 * templates are deleted, and what it still had waiting is taken out of the
 * queue and logged as failed.
 */
export async function removePluginMail(db: DbClient, pluginId: string): Promise<void> {
  const prefix = pluginMailTemplatePrefix(pluginId)
  await db`delete from mail_templates where substr(template_key, 1, ${prefix.length}) = ${prefix}`
  const { rows } = await db<{ outbox_id: string; attempts: number }>`
    select outbox_id, attempts from mail_queue where source = ${pluginId}
  `
  await db`delete from mail_queue where source = ${pluginId}`
  await clearMailCounters(db, pluginId)
  for (const row of rows) {
    await updateMailProgress(db, row.outbox_id, {
      status: 'failed',
      attempts: Number(row.attempts),
      error: 'The plugin that asked for this email was uninstalled before it was sent.',
    })
  }
}
