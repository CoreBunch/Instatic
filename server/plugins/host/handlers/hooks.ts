/**
 * Hook bus handlers — implements cms.hooks.on, cms.hooks.filter, and
 * cms.hooks.emit api-calls.
 *
 * All three are gated by the `cms.hooks` permission, enforced centrally in
 * apiDispatch.ts (via TARGET_PERMISSIONS) before these handlers run. That
 * permission opens the bus and nothing more: what a plugin may register for
 * is decided per name by `assertMayRegisterHook` (rules in
 * `protocol/hookRules.ts`), and what it is then handed is checked again on
 * every send. Listeners and filters are thin shims that round-trip to the
 * plugin's worker via the RPC layer.
 */

import { canonicalPluginEventName, hookBus } from '@core/plugins/hookBus'
import { owningPluginId } from '@core/plugins/namespaceOwnership'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import { hostFilterRule } from '../../protocol/hookRules'
import type { DbClient } from '../../../db/client'
import { listInstalledPluginIds } from '../../../repositories/plugins'
import { replyApiOk } from '../apiReplies'
import { assertMayRegisterHook } from '../hookAccess'
import { hostPlugins } from '../registry'
import { runHookListenerInWorker, runHookFilterInWorker } from '../rpc'
import type { HostPluginRecord } from '../types'
import { deliverHeldMailOutcomes } from './mail'

export async function handleHooksOn(
  msg: ApiCallFor<'cms.hooks.on'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ event, listenerId }] = msg.args
  // A plugin that could never be sent this event is told so now.
  assertMayRegisterHook(entry, 'event', event)
  entry.hookListeners.push({ pluginId: msg.pluginId, listenerId })
  // The hookBus listener is a thin shim that round-trips back to the worker.
  hookBus.on(msg.pluginId, event, async (payload: unknown) => {
    await runHookListenerInWorker(msg.pluginId, listenerId, event, payload)
  })
  // News about its own email that arrived while it was not listening.
  await deliverHeldMailOutcomes(db, msg.pluginId, event)
  replyApiOk(msg.pluginId, msg.correlationId)
}

/** A name the host applies as a filter, proven by its rule. */
function isHostFilterName(name: string): name is Parameters<typeof hookBus.filter>[1] {
  return hostFilterRule(name) !== null
}

export async function handleHooksFilter(
  msg: ApiCallFor<'cms.hooks.filter'>,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ name, filterId }] = msg.args
  // Refuses unknown names, names with their own registration call (the media
  // URL chain) and values the plugin was never granted.
  assertMayRegisterHook(entry, 'filter', name)
  if (!isHostFilterName(name)) throw new Error(`The host applies no filter named "${name}".`)
  entry.hookFilters.push({ pluginId: msg.pluginId, filterId })
  hookBus.filter(msg.pluginId, name, async (value: unknown, context: { pluginId: string } & Record<string, unknown>) => {
    return await runHookFilterInWorker(msg.pluginId, filterId, name, value, context)
  })
  replyApiOk(msg.pluginId, msg.correlationId)
}

export async function handleHooksEmit(
  msg: ApiCallFor<'cms.hooks.emit'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ event, payload }] = msg.args
  // SECURITY: plugin emits are force-namespaced to `plugin.<id>.<name>` so a
  // plugin can never forge a core/host event (`settings.changed`,
  // `content.entry.*`, `publish.*`) or impersonate another plugin's namespace
  // (that throws, surfacing as an api-error reply via dispatchApiCall).
  // `msg.pluginId` is the host-verified worker identity (validated against
  // the worker in workerPool), never plugin-supplied data.
  const canonicalEvent = canonicalPluginEventName(msg.pluginId, event)
  // `plugin.acme.vault.x.paid` starts with `plugin.acme.vault.` too: with
  // nested plugin ids the prefix does not settle whose event it is. The owner
  // is the installed (or loaded) plugin with the longest matching id.
  const owner = owningPluginId(canonicalEvent.slice('plugin.'.length), [
    ...(await listInstalledPluginIds(db)),
    ...hostPlugins.keys(),
  ])
  if (owner !== msg.pluginId) {
    throw new Error(
      `Plugin "${msg.pluginId}" cannot emit "${canonicalEvent}": that name belongs to plugin "${owner}".`,
    )
  }
  await hookBus.emit(canonicalEvent, payload)
  // Resolve the emit with the canonical name so plugin authors can log /
  // share the exact name other plugins must subscribe to.
  replyApiOk(msg.pluginId, msg.correlationId, canonicalEvent)
}
