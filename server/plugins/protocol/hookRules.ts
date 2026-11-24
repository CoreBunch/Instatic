/**
 * Host hook rules — the SINGLE table saying what a plugin must have been
 * granted to listen to each host event or to filter each host value.
 *
 * `cms.hooks` lets a plugin use the hook bus. It does not, by itself, let the
 * plugin see or change anything another permission guards: an event or filter
 * that carries guarded data needs that data's own permission too.
 *
 * Read by three places, so they cannot drift:
 *   - HOST registration (`host/handlers/hooks.ts`): a plugin that could never
 *     qualify is refused when it registers, with the reason.
 *   - HOST delivery (`host/hookAccess.ts`): every send re-checks the receiving
 *     plugin, per table where the rule is per table.
 *   - VM (`quickjs/bootstrap/src/buildApi.ts`): the same refusal, thrown
 *     synchronously inside the sandbox so an un-awaited registration still
 *     fails loudly.
 *
 * The record types are keyed by the bus's own name unions, so a new host
 * event or filter cannot be emitted or applied before its rule is written
 * here (`tsc` fails), and `plugin-hook-rules.test.ts` checks the call sites.
 *
 * NOTE: bundled into the QuickJS VM. Keep the runtime surface PURE DATA and
 * pure functions; only `import type` is allowed.
 */

import type { GuardedHostEvent, HostEventName, HostFilterName } from '@core/plugins/hookBus'
import type { PluginPermission } from '@core/plugin-sdk'
import type { ContentAccessMode } from '@core/plugin-sdk/contentSchemas'

export type HookRule =
  /** Nothing guarded travels: the hooks permission is enough. */
  | { needs: 'hooks' }
  /** The payload is guarded by one permission. */
  | { needs: 'permission'; permission: PluginPermission }
  /**
   * The payload belongs to a content table: the plugin needs every listed
   * mode on THAT table (its permission granted and a `contentAccess` entry).
   */
  | { needs: 'table'; modes: readonly ContentAccessMode[] }
  /** News about one plugin's own business; the host sends it to that plugin only. */
  | { needs: 'owner' }
  /** A host-internal pipeline with its own registration call. Never through `cms.hooks`. */
  | { needs: 'dedicated'; registerWith: string; permission: PluginPermission }

export const HOST_EVENT_RULES = {
  'publish.before': { needs: 'hooks' },
  'publish.after': { needs: 'hooks' },
  'content.entry.created': { needs: 'table', modes: ['read'] },
  'content.entry.updated': { needs: 'table', modes: ['read'] },
  'content.entry.deleted': { needs: 'table', modes: ['read'] },
  'member.created': { needs: 'permission', permission: 'members.read' },
  'member.verified': { needs: 'permission', permission: 'members.read' },
  'member.signedIn': { needs: 'permission', permission: 'members.read' },
  'member.tagged': { needs: 'permission', permission: 'members.read' },
  'member.deleted': { needs: 'permission', permission: 'members.read' },
  'settings.changed': { needs: 'owner' },
  'mail.delivered': { needs: 'owner' },
  'mail.failed': { needs: 'owner' },
} as const satisfies Record<HostEventName, HookRule>

/**
 * The bus requires a recipient check, by type, for `GuardedHostEvent` names.
 * These two lines make that list and this table agree: a name whose rule is
 * per table or per permission must be in the list, and nothing else may be.
 */
type RuledAsGuarded = {
  [Name in HostEventName]: (typeof HOST_EVENT_RULES)[Name]['needs'] extends 'table' | 'permission' ? Name : never
}[HostEventName]
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export const GUARDED_EVENTS_MATCH_THEIR_RULES: Same<RuledAsGuarded, GuardedHostEvent> = true

export const HOST_FILTER_RULES: Readonly<Record<HostFilterName, HookRule>> = {
  // Public pages as they are sent. Renders that are not public are held back
  // where they are rendered (`publish/publishedHtmlPipeline.ts`).
  'publish.html': { needs: 'hooks' },
  // The filter sees an entry's cells and what it returns is saved.
  'content.entry.cells': { needs: 'table', modes: ['read', 'write'] },
  'media.url.transform': {
    needs: 'dedicated',
    registerWith: 'api.cms.media.registerUrlTransformer',
    permission: 'media.url.transform',
  },
}

/** The permission each content-access mode consumes (mirrors `CONTENT_ACCESS_MODE_PERMISSIONS`). */
const MODE_PERMISSION: Readonly<Record<ContentAccessMode, PluginPermission>> = {
  read: 'cms.content.read',
  write: 'cms.content.write',
  publish: 'cms.content.publish',
  delete: 'cms.content.delete',
}

/** The permissions a table rule's modes consume. */
export function permissionsForModes(modes: readonly ContentAccessMode[]): PluginPermission[] {
  return modes.map((mode) => MODE_PERMISSION[mode])
}

function hasOwn<T extends object>(table: T, name: string): name is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(table, name)
}

/** The rule for a host event, or null when the host emits no event of that name. */
export function hostEventRule(name: string): HookRule | null {
  const rules: Readonly<Record<string, HookRule>> = HOST_EVENT_RULES
  return hasOwn(HOST_EVENT_RULES, name) ? rules[name] ?? null : null
}

/** The rule for a host filter, or null when the host applies no filter of that name. */
export function hostFilterRule(name: string): HookRule | null {
  return hasOwn(HOST_FILTER_RULES, name) ? HOST_FILTER_RULES[name] : null
}

const PLUGIN_EVENT_PREFIX = 'plugin.'

/**
 * Why a plugin holding `granted` may not register for `name`, or null when
 * permissions alone do not rule it out. The per-table half of a table rule
 * (does any `contentAccess` entry cover the modes) is the host's to check: the
 * sandbox does not hold the manifest's table list.
 */
export function hookRegistrationRefusal(
  kind: 'event' | 'filter',
  name: string,
  granted: readonly string[],
): string | null {
  if (kind === 'event' && name.startsWith(PLUGIN_EVENT_PREFIX)) return null
  const rule = kind === 'event' ? hostEventRule(name) : hostFilterRule(name)
  if (!rule) {
    return kind === 'event'
      ? `the host emits no event named "${name}". Another plugin's event is "plugin.<its-id>.<name>".`
      : `the host applies no filter named "${name}".`
  }
  if (rule.needs === 'dedicated') {
    return `"${name}" is registered with ${rule.registerWith} (permission "${rule.permission}"), not through cms.hooks.`
  }
  const required = rule.needs === 'permission'
    ? [rule.permission]
    : rule.needs === 'table'
      ? permissionsForModes(rule.modes)
      : []
  const missing = required.filter((permission) => granted.indexOf(permission) < 0)
  return missing.length > 0
    ? `"${name}" carries data guarded by ${missing.map((permission) => `"${permission}"`).join(' and ')}, which this plugin was not granted.`
    : null
}
