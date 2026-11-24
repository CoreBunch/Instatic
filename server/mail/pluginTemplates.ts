/**
 * A plugin's email templates in the catalogue, and what is left of a
 * plugin's email when it is uninstalled.
 *
 * The catalogue follows the database, one plugin at a time:
 * `syncPluginMailTemplates` gives every installed, enabled plugin exactly
 * the templates its manifest declares and takes out those of plugins that
 * are disabled or gone. Each plugin's set is replaced in one synchronous
 * step, and no plugin's templates are ever cleared to be put back later, so
 * there is no moment at which a loaded plugin's template is missing. (The
 * queue also does not take a missing template for final while its plugin is
 * installed: see `attemptQueuedMail`.)
 *
 * Wording edits and disabled sending settings use the same template keys. They
 * survive disabling and upgrading; an edit of a template an upgrade no
 * longer declares is deleted, and all of them go with the plugin.
 */
import {
  listMailTemplateDefinitions,
  registerMailTemplate,
  unregisterMailTemplate,
} from '@core/mail'
import type { PluginManifest } from '@core/plugin-sdk'
import { pluginMailTemplateDefinitions, pluginMailTemplatePrefix } from '@core/plugins/manifestMail'
import type { DbClient } from '../db/client'
import { listInstalledPlugins } from '../repositories/plugins'
import { discardQueuedMail } from './delivery'
import { clearMailCounters } from './limits'

/** A plugin template key is `plugin.<pluginId>~<key>`; nothing else in the catalogue contains `~`. */
const PLUGIN_KEY_MARK = '~'

/** Make one plugin's templates in the catalogue exactly `manifest`'s, in one step. */
function setPluginMailTemplates(manifest: Pick<PluginManifest, 'id' | 'name' | 'mail'>): void {
  const prefix = pluginMailTemplatePrefix(manifest.id)
  const declared = pluginMailTemplateDefinitions(manifest)
  const keys = new Set(declared.map((definition) => definition.key))
  // Add and replace first, then drop what is no longer declared: a key that
  // stays is never absent in between.
  for (const definition of declared) registerMailTemplate(definition)
  for (const definition of listMailTemplateDefinitions()) {
    if (definition.key.startsWith(prefix) && !keys.has(definition.key)) unregisterMailTemplate(definition.key)
  }
}

function unsetPluginMailTemplates(pluginId: string): void {
  setPluginMailTemplates({ id: pluginId, name: pluginId })
}

/**
 * Bring the catalogue in line with the installed plugins. Called after
 * every change to a plugin (install, upgrade, enable, disable, uninstall)
 * and at boot. Also deletes the owner's edits of templates a plugin no
 * longer declares.
 */
export async function syncPluginMailTemplates(db: DbClient): Promise<void> {
  const enabled = new Set<string>()
  for (const result of await listInstalledPlugins(db)) {
    if (result.kind !== 'ok') continue
    const { plugin } = result
    if (plugin.enabled) {
      setPluginMailTemplates(plugin.manifest)
      enabled.add(plugin.id)
    } else {
      unsetPluginMailTemplates(plugin.id)
    }
    await deleteStaleTemplateSettings(db, plugin.manifest)
  }
  // Templates of plugins that are no longer installed at all.
  for (const definition of listMailTemplateDefinitions()) {
    const mark = definition.key.indexOf(PLUGIN_KEY_MARK)
    if (mark < 0) continue
    const pluginId = definition.key.slice('plugin.'.length, mark)
    if (!enabled.has(pluginId)) unregisterMailTemplate(definition.key)
  }
}

/** Forget settings for any template the plugin has dropped. */
async function deleteStaleTemplateSettings(db: DbClient, manifest: Pick<PluginManifest, 'id' | 'name' | 'mail'>): Promise<void> {
  const prefix = pluginMailTemplatePrefix(manifest.id)
  const declared = new Set(pluginMailTemplateDefinitions(manifest).map((definition) => definition.key))
  const { rows } = await db<{ template_key: string }>`
    select template_key from mail_templates where substr(template_key, 1, ${prefix.length}) = ${prefix}
    union
    select template_key from disabled_mail_templates where substr(template_key, 1, ${prefix.length}) = ${prefix}
  `
  for (const row of rows) {
    if (declared.has(row.template_key)) continue
    await db`delete from mail_templates where template_key = ${row.template_key}`
    await db`delete from disabled_mail_templates where template_key = ${row.template_key}`
  }
}

/**
 * An uninstalled plugin leaves no email behind: its templates leave the
 * catalogue, the owner's edits of them are deleted, what it still had
 * waiting is taken out of the queue and logged as failed, and its limit
 * counters are forgotten.
 */
export async function removePluginMail(db: DbClient, pluginId: string): Promise<void> {
  unsetPluginMailTemplates(pluginId)
  const prefix = pluginMailTemplatePrefix(pluginId)
  await db`delete from mail_templates where substr(template_key, 1, ${prefix.length}) = ${prefix}`
  await db`delete from disabled_mail_templates where substr(template_key, 1, ${prefix.length}) = ${prefix}`
  await discardQueuedMail(
    db,
    'source',
    pluginId,
    'The plugin that asked for this email was uninstalled before it was sent.',
    null,
  )
  await clearMailCounters(db, pluginId)
}
