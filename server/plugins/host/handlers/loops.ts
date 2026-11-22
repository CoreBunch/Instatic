/**
 * Loop source registration handler — implements the `cms.loops.registerSource`
 * api-call.
 *
 * Gated by the `loops.register` permission, enforced centrally in
 * apiDispatch.ts (via TARGET_PERMISSIONS) before this handler runs. The registered source is a shim
 * that delegates its `fetch` method to the plugin's worker via the RPC layer.
 * It has no `preview`: that one runs in the browser for in-process sources.
 * The editor learns of a plugin's sources and previews them through
 * `../loopSources.ts`.
 */

import { nanoid } from 'nanoid'
import { loopSourceRegistry } from '@core/loops/registry'
import type { SourceFetchContext, SourceRequestContext } from '@core/loops/types'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiOk } from '../apiReplies'
import { assertOwnsNamespacedId, hostPluginHasPermission, hostPlugins } from '../registry'
import { runLoopFetchInWorker } from '../rpc'
import type { HostPluginRecord } from '../types'

/**
 * The request a plugin source is sent, checked here whatever the caller
 * built. A source that is not per-visitor gets neither the visitor's cookies
 * nor the member. A per-visitor source gets the cookies, and the member only
 * while the plugin holds `members.read` (asked on every fetch, so a
 * withdrawn grant takes effect at once).
 */
export function requestForPluginSource(
  pluginId: string,
  perVisitor: boolean,
  request: SourceRequestContext | undefined,
): SourceRequestContext | undefined {
  if (!request) return undefined
  const { member, ...rest } = request
  if (!perVisitor) return { ...rest, cookies: {} }
  return member !== undefined && pluginMayKnowMember(pluginId) ? { ...rest, member } : rest
}

function pluginMayKnowMember(pluginId: string): boolean {
  return hostPluginHasPermission(pluginId, 'members.read')
}

export async function handleLoopsRegisterSource(
  msg: ApiCallFor<'cms.loops.registerSource'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [descriptor] = msg.args
  await assertOwnsNamespacedId(db, msg.pluginId, descriptor.id, 'Loop source')
  // A source of this id registered earlier by another plugin: it registered
  // under a shorter id prefix before this plugin was loaded (the check above
  // rules out every other case). The id is this plugin's; the other loses it.
  for (const [otherId, other] of hostPlugins) {
    if (otherId === msg.pluginId) continue
    other.loopSources = other.loopSources.filter((source) => source.sourceId !== descriptor.id)
  }
  const fullSource = {
    ...descriptor,
    fetch: async (ctx: unknown) => {
      // The full SourceFetchContext carries `db` (a function) and the entire
      // `site` document — neither survives `postMessage` structured-clone to
      // the worker. Send only the serializable subset the plugin fetch needs;
      // plugins reach the DB via `api.cms.storage` and the network via
      // `api.net.fetch`, not a raw DB handle.
      const c = ctx as SourceFetchContext
      const wireCtx = {
        filters: c.filters,
        orderBy: c.orderBy,
        direction: c.direction,
        limit: c.limit,
        offset: c.offset,
        request: requestForPluginSource(msg.pluginId, descriptor.perVisitor === true, c.request),
        site: { id: c.site?.id, name: c.site?.name },
      }
      return await runLoopFetchInWorker(msg.pluginId, descriptor.id, wireCtx)
    },
    // Lets a render skip the member lookup for a plugin that would not be sent it.
    mayKnowMember: () => pluginMayKnowMember(msg.pluginId),
  }
  // Registering the same id again replaces the source; it is still one source.
  const registered = entry.loopSources.find((source) => source.sourceId === descriptor.id)
  if (registered) registered.revision = nanoid()
  else entry.loopSources.push({ pluginId: msg.pluginId, sourceId: descriptor.id, revision: nanoid() })
  loopSourceRegistry.registerOrReplace(fullSource)
  replyApiOk(msg.pluginId, msg.correlationId)
}
