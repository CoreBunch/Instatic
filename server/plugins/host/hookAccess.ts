/**
 * Who may register for, and who is handed, a host event or filter value.
 *
 * The rules themselves are one table, `protocol/hookRules.ts`. This module
 * applies them on the host with what only the host knows: the plugin's
 * granted permissions and its `contentAccess[]` entries.
 *
 * Two moments, both checked:
 *   - registration — a plugin that could never qualify is refused, so its
 *     author gets an error instead of a listener that never fires;
 *   - delivery — every send asks again, for the table at hand.
 */

import type { HookRecipientCheck, MemberHookEvent } from '@core/plugins/hookBus'
import type { ContentAccessMode } from '@core/plugin-sdk/contentSchemas'
import {
  HOST_EVENT_RULES,
  HOST_FILTER_RULES,
  hookRegistrationRefusal,
  hostEventRule,
  hostFilterRule,
  type HookRule,
} from '../protocol/hookRules'
import {
  hostPluginHasPermission,
  hostPlugins,
  pluginDeclaresContentAccessModes,
  pluginHasContentTableAccess,
  type ContentAccessTable,
} from './registry'
import type { HostPluginRecord } from './types'

/** Refuse a registration the plugin could never be served. Throws with the reason. */
export function assertMayRegisterHook(entry: HostPluginRecord, kind: 'event' | 'filter', name: string): void {
  const refusal = hookRegistrationRefusal(kind, name, entry.manifest.grantedPermissions ?? [])
  if (refusal) throw new Error(`Plugin "${entry.manifest.id}" cannot register for "${name}": ${refusal}`)
  const rule = kind === 'event' ? hostEventRule(name) : hostFilterRule(name)
  if (rule?.needs === 'table' && !pluginDeclaresContentAccessModes(entry, rule.modes)) {
    throw new Error(
      `Plugin "${entry.manifest.id}" cannot register for "${name}": no contentAccess entry declares ` +
        `${rule.modes.map((mode) => `"${mode}"`).join(' and ')}, so no table could ever be sent to it.`,
    )
  }
}

function tableModes(rule: HookRule, name: string): readonly ContentAccessMode[] {
  if (rule.needs !== 'table') throw new Error(`[hookAccess] "${name}" is not a per-table hook`)
  return rule.modes
}

/** Which plugins may hear a per-table host event about an entry of `table`. */
export function entryEventRecipients(
  event: 'content.entry.created' | 'content.entry.updated' | 'content.entry.deleted',
  table: ContentAccessTable,
): HookRecipientCheck {
  return tableRecipients(tableModes(HOST_EVENT_RULES[event], event), table)
}

/** Which plugins may filter the cells of an entry of `table`. */
export function entryCellsFilterRecipients(table: ContentAccessTable): HookRecipientCheck {
  return tableRecipients(tableModes(HOST_FILTER_RULES['content.entry.cells'], 'content.entry.cells'), table)
}

/** Which plugins may hear a host event guarded by one permission (the member events). */
export function permissionEventRecipients(event: MemberHookEvent): HookRecipientCheck {
  const rule = HOST_EVENT_RULES[event]
  if (rule.needs !== 'permission') throw new Error(`[hookAccess] "${event}" is not a permission-guarded event`)
  const { permission } = rule
  return (pluginId) => hostPluginHasPermission(pluginId, permission)
}

function tableRecipients(modes: readonly ContentAccessMode[], table: ContentAccessTable): HookRecipientCheck {
  return (pluginId) => {
    const entry = hostPlugins.get(pluginId)
    return entry !== undefined && pluginHasContentTableAccess(entry, table, modes)
  }
}
