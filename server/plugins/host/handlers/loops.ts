/**
 * Loop source registration handler — implements the `cms.loops.registerSource`
 * api-call.
 *
 * Gated by the `loops.register` permission, enforced centrally in
 * apiDispatch.ts (via TARGET_PERMISSIONS) before this handler runs. The registered source is a shim
 * that delegates its `fetch` method to the plugin's worker via the RPC layer.
 * The `preview` method is intentionally a no-op (returns []) — the editor
 * uses the publisher's fetch path for live preview (see useLoopPreviewItems),
 * and any plugin that ships a synchronous preview-only path can be added later
 * via a worker-backed sync invariant.
 */

import { loopSourceRegistry } from '@core/loops/registry'
import type { SourceFetchContext, SourceRequestContext } from '@core/loops/types'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiOk } from '../apiReplies'
import { hostPluginHasPermission } from '../registry'
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
  _db: DbClient,
): Promise<void> {
  const [descriptor] = msg.args
  if (!descriptor.id?.startsWith(`${msg.pluginId}.`)) {
    throw new Error(
      `Loop source id "${descriptor.id}" must start with the plugin id "${msg.pluginId}.".`,
    )
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
    preview: () => {
      return []
    },
    // Lets a render skip the member lookup for a plugin that would not be sent it.
    mayKnowMember: () => pluginMayKnowMember(msg.pluginId),
  }
  entry.loopSources.push({ pluginId: msg.pluginId, sourceId: descriptor.id })
  loopSourceRegistry.registerOrReplace(fullSource)
  replyApiOk(msg.pluginId, msg.correlationId)
}
