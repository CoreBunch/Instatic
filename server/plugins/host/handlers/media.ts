/**
 * Media plugin handlers — managed remote ingestion plus adapter, URL
 * transformer, and variant-delegate registration.
 *
 * Each target is gated by its own permission, enforced centrally in
 * apiDispatch.ts (via TARGET_PERMISSIONS) before these handlers run:
 *   - `media.import.remote` for host-mediated remote ingestion
 *   - `media.storage.adapter` for storage adapter registration
 *   - `media.url.transform` for URL transformer registration
 *   - `media.variant.delegate` for variant delegate registration
 *
 * The actual adapter logic lives inside the QuickJS worker; the host-side
 * shim proxies every method call back through the worker RPC layer.
 * Bytes NEVER cross the sandbox boundary — see the media-storage-no-bytes-in-sandbox
 * architecture gate.
 */

import type { MediaAssetRole, MediaStorageServingMode } from '@core/plugin-sdk'
import { hookBus } from '@core/plugins/hookBus'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { mediaVariantDelegateRegistry } from '@core/plugins/mediaVariantDelegateRegistry'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiOk } from '../apiReplies'
import { buildAdapterShim, runMediaUrlTransformerInWorker } from '../media'
import type { HostPluginRecord } from '../types'
import { assertHostPluginPermission } from '../registry'
import { upsertRemoteMediaAsset } from '../../../media/remoteIngestion'

export async function handleMediaUpsertRemote(
  msg: ApiCallFor<'cms.media.upsertRemote'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  // Fetching the source is a second, independent authority. Keep the media
  // mutation and network grants separate in the install consent model.
  assertHostPluginPermission(entry, 'network.outbound')
  const [input] = msg.args
  const result = await upsertRemoteMediaAsset(db, {
    pluginId: msg.pluginId,
    networkAllowedHosts: entry.manifest.networkAllowedHosts ?? [],
    input,
  })
  replyApiOk(msg.pluginId, msg.correlationId, result)
}

export async function handleMediaRegisterStorageAdapter(
  msg: ApiCallFor<'cms.media.registerStorageAdapter'>,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [arg] = msg.args
  // Schema-validated, so the cast is for the union narrowing the
  // SDK exposes. servingMode + roles are already validated as the
  // expected literal sets.
  const adapter = buildAdapterShim({
    pluginId: msg.pluginId,
    adapterId: arg.adapterId,
    label: arg.label,
    roles: arg.roles as ReadonlyArray<MediaAssetRole>,
    servingMode: arg.servingMode as MediaStorageServingMode,
    hasGetReadUrl: arg.hasGetReadUrl,
    hasReadStream: arg.hasReadStream,
    ...(arg.cspOrigins ? { cspOrigins: arg.cspOrigins } : {}),
  })
  // Registry.register throws on a reserved id (e.g. ''); let it bubble
  // so the plugin sees a real exception instead of a silent failure.
  // The outer try/catch in dispatchApiCall converts it to a structured
  // api-call error reply.
  mediaStorageRegistry.register(adapter)
  entry.mediaAdapters.push({ pluginId: msg.pluginId, adapterId: arg.adapterId })
  replyApiOk(msg.pluginId, msg.correlationId)
}

export async function handleMediaRegisterUrlTransformer(
  msg: ApiCallFor<'cms.media.registerUrlTransformer'>,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ transformerId }] = msg.args
  entry.mediaUrlTransformers.push({ pluginId: msg.pluginId, transformerId })
  // URL transformers ride the existing hook bus filter pipeline so
  // chaining + error-fallback semantics match every other plugin
  // filter. The filter input is `{ path, ctx }` and the host applies
  // it via `hookBus.applyFilter('media.url.transform', ...)` at the
  // render boundary (Phase C wires the boundary).
  hookBus.filter(msg.pluginId, 'media.url.transform', async (value) => {
    const payload = value as { path: string; ctx: unknown }
    const rewritten = await runMediaUrlTransformerInWorker(
      msg.pluginId,
      transformerId,
      payload,
    )
    // null = "no rewrite" — chain through. String = the new path.
    if (typeof rewritten === 'string') {
      return { ...payload, path: rewritten }
    }
    return value
  })
  replyApiOk(msg.pluginId, msg.correlationId)
}

export async function handleMediaRegisterVariantDelegate(
  msg: ApiCallFor<'cms.media.registerVariantDelegate'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [arg] = msg.args
  // Persist in the in-memory registry so the admin UI's
  // "Pick a delegate" picker sees it. Election (which delegate
  // actually wins) lives in `active_media_variant_delegate` and
  // is managed by the admin API in `server/handlers/cms/mediaStorageAdmin.ts`.
  mediaVariantDelegateRegistry.register({
    id: arg.delegateId,
    pluginId: msg.pluginId,
    variantUrlTemplate: arg.variantUrlTemplate,
    widths: arg.widths,
    formats: arg.formats,
  })
  replyApiOk(msg.pluginId, msg.correlationId)
}
