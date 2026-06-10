/**
 * Hook bus handlers — implements cms.hooks.on, cms.hooks.filter, and
 * cms.hooks.emit api-calls.
 *
 * All three are gated by the `cms.hooks` permission, enforced centrally in
 * apiDispatch.ts (via TARGET_PERMISSIONS) before these handlers run. Listeners
 * and filters are thin shims that round-trip to the plugin's worker via the RPC layer.
 */

import { canonicalPluginEventName, hookBus } from '@core/plugins/hookBus'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiOk } from '../apiReplies'
import { runHookListenerInWorker, runHookFilterInWorker } from '../rpc'
import type { HostPluginRecord } from '../types'

export async function handleHooksOn(
  msg: ApiCallFor<'cms.hooks.on'>,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ event, listenerId }] = msg.args
  entry.hookListeners.push({ pluginId: msg.pluginId, listenerId })
  // The hookBus listener is a thin shim that round-trips back to the worker.
  hookBus.on(msg.pluginId, event, async (payload: unknown) => {
    await runHookListenerInWorker(msg.pluginId, listenerId, event, payload)
  })
  replyApiOk(msg.pluginId, msg.correlationId)
}

export async function handleHooksFilter(
  msg: ApiCallFor<'cms.hooks.filter'>,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ name, filterId }] = msg.args
  entry.hookFilters.push({ pluginId: msg.pluginId, filterId })
  hookBus.filter(msg.pluginId, name, async (value: unknown, context: { pluginId: string } & Record<string, unknown>) => {
    return await runHookFilterInWorker(msg.pluginId, filterId, name, value, context)
  })
  replyApiOk(msg.pluginId, msg.correlationId)
}

export async function handleHooksEmit(
  msg: ApiCallFor<'cms.hooks.emit'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ event, payload }] = msg.args
  // SECURITY: plugin emits are force-namespaced to `plugin.<id>.<name>` so a
  // plugin can never forge a core/host event (`settings.changed`,
  // `content.entry.*`, `publish.*`) or impersonate another plugin's namespace
  // (that throws, surfacing as an api-error reply via dispatchApiCall).
  // `msg.pluginId` is the host-verified worker identity (validated against
  // the worker in workerPool), never plugin-supplied data.
  const canonicalEvent = canonicalPluginEventName(msg.pluginId, event)
  await hookBus.emit(canonicalEvent, payload)
  // Resolve the emit with the canonical name so plugin authors can log /
  // share the exact name other plugins must subscribe to.
  replyApiOk(msg.pluginId, msg.correlationId, canonicalEvent)
}
