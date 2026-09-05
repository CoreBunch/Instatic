/**
 * Inbound api-call dispatch — routes each validated api-call from a plugin
 * worker to the appropriate host-side handler.
 *
 * A typed handler table maps each target to its named handler function in
 * `handlers/`. Each handler is responsible for permission checks, argument
 * coercion, and calling `replyApiOk` exactly once. The outer try/catch
 * converts any unhandled throw into a structured error reply so correlation
 * ids are never leaked.
 *
 * SECURITY: permission enforcement is CENTRALIZED here. Before any handler
 * runs, the dispatcher looks up the target's required permission in the single
 * `TARGET_PERMISSIONS` map and calls `assertHostPluginPermission` — the
 * kernel-of-correctness check. The VM-side bootstrap drives its synchronous
 * defense-in-depth check from the SAME map (bundled in via `bootstrap:sync`),
 * so the two layers can never assert different permissions. Handlers keep only
 * the checks a static target→permission map cannot express (the conditional
 * `cms.routes.public` grant; the per-table `contentAccess[]` allowlist).
 *
 * Permission authority is `grantedPermissions`, never the declared array.
 */

import type { AllowedApiTarget, ValidatedApiCall } from '../protocol/apiCallSchema'
import { TARGET_PERMISSIONS } from '../protocol/targets'
import type { DbClient } from '../../db/client'
import { hostPlugins, getDbForApi, assertHostPluginPermission } from './registry'
import { replyApiError } from './apiReplies'
import type { HostPluginRecord } from './types'
import { handleRoutesRegister } from './handlers/routes'
import { handleHooksOn, handleHooksFilter, handleHooksEmit } from './handlers/hooks'
import { handleLoopsRegisterSource } from './handlers/loops'
import { handleStorageList, handleStorageCreate, handleStorageUpdate, handleStorageDelete } from './handlers/storage'
import { handleSettingsReplace } from './handlers/settings'
import { handleNetworkFetch, handleNetworkAbort } from './handlers/network'
import { handleScheduleRegister, handleScheduleCancel } from './handlers/schedule'
import {
  handleMediaRegisterStorageAdapter,
  handleMediaRegisterUrlTransformer,
  handleMediaRegisterVariantDelegate,
  handleMediaUpsert,
} from './handlers/media'
import { handleCryptoDigest, handleCryptoSignHmac } from './handlers/crypto'
import {
  handleContentEntriesCreate,
  handleContentEntriesCreateMany,
  handleContentEntriesDelete,
  handleContentEntriesDeleteMany,
  handleContentEntriesGet,
  handleContentEntriesGetBySlug,
  handleContentEntriesList,
  handleContentEntriesMoveTable,
  handleContentEntriesPublish,
  handleContentEntriesUpdate,
  handleContentEntriesUpdateMany,
  handleContentRepublishAll,
  handleContentSearch,
  handleContentSnapshot,
  handleContentTablesCreate,
  handleContentTablesGet,
  handleContentTablesList,
  handleContentTreeMutate,
  handleContentTreeRead,
  handleContentTreeReplace,
} from './handlers/content'

type HostApiHandler<TTarget extends AllowedApiTarget> = (
  msg: Extract<ValidatedApiCall, { target: TTarget }>,
  entry: HostPluginRecord,
  db: DbClient,
) => Promise<void>
/**
 * One handler per target, keyed by the SSOT target union. Because
 * `AllowedApiTarget = keyof typeof ApiCallSchemas`, a schema added without a
 * handler (or a handler for a target with no schema) is now a COMPILE error
 * at the `satisfies HostApiHandlerTable` below — not a runtime
 * "is not a function".
 */
type HostApiHandlerTable = { [Target in AllowedApiTarget]: HostApiHandler<Target> }
type AnyHostApiHandler = (
  msg: ValidatedApiCall,
  entry: HostPluginRecord,
  db: DbClient,
) => Promise<void>

const apiHandlers = {
  'cms.routes.register': handleRoutesRegister,
  'cms.hooks.on': handleHooksOn,
  'cms.hooks.filter': handleHooksFilter,
  'cms.hooks.emit': handleHooksEmit,
  'cms.loops.registerSource': handleLoopsRegisterSource,
  'cms.storage.list': handleStorageList,
  'cms.storage.create': handleStorageCreate,
  'cms.storage.update': handleStorageUpdate,
  'cms.storage.delete': handleStorageDelete,
  'cms.settings.replace': handleSettingsReplace,
  'network.fetch': handleNetworkFetch,
  'network.abort': handleNetworkAbort,
  'cms.schedule.register': handleScheduleRegister,
  'cms.schedule.cancel': handleScheduleCancel,
  'cms.media.upsert': handleMediaUpsert,
  'cms.media.registerStorageAdapter': handleMediaRegisterStorageAdapter,
  'cms.media.registerUrlTransformer': handleMediaRegisterUrlTransformer,
  'cms.media.registerVariantDelegate': handleMediaRegisterVariantDelegate,
  'crypto.digest': handleCryptoDigest,
  'crypto.signHmac': handleCryptoSignHmac,
  'cms.content.tables.list': handleContentTablesList,
  'cms.content.tables.get': handleContentTablesGet,
  'cms.content.tables.create': handleContentTablesCreate,
  'cms.content.entries.list': handleContentEntriesList,
  'cms.content.entries.get': handleContentEntriesGet,
  'cms.content.entries.getBySlug': handleContentEntriesGetBySlug,
  'cms.content.entries.create': handleContentEntriesCreate,
  'cms.content.entries.update': handleContentEntriesUpdate,
  'cms.content.entries.delete': handleContentEntriesDelete,
  'cms.content.entries.publish': handleContentEntriesPublish,
  'cms.content.entries.moveTable': handleContentEntriesMoveTable,
  'cms.content.entries.createMany': handleContentEntriesCreateMany,
  'cms.content.entries.updateMany': handleContentEntriesUpdateMany,
  'cms.content.entries.deleteMany': handleContentEntriesDeleteMany,
  'cms.content.tree.read': handleContentTreeRead,
  'cms.content.tree.mutate': handleContentTreeMutate,
  'cms.content.tree.replace': handleContentTreeReplace,
  'cms.content.search': handleContentSearch,
  'cms.content.snapshot': handleContentSnapshot,
  'cms.content.republishAll': handleContentRepublishAll,
} satisfies HostApiHandlerTable

export async function dispatchApiCall(msg: ValidatedApiCall): Promise<void> {
  const db = getDbForApi()
  if (!db) {
    replyApiError(msg.pluginId, msg.correlationId, 'Plugin worker host has no DbClient configured')
    return
  }
  const entry = hostPlugins.get(msg.pluginId)
  if (!entry) {
    replyApiError(msg.pluginId, msg.correlationId, `Plugin "${msg.pluginId}" is not loaded`)
    return
  }

  try {
    // Centralized permission enforcement — one lookup in the single
    // target→permission map, applied before the handler runs. Targets absent
    // from the map (settings.replace, network.abort, crypto.*) are
    // intentionally ungated. Conditional/per-table checks remain in handlers.
    const requiredPermission = TARGET_PERMISSIONS[msg.target as keyof typeof TARGET_PERMISSIONS]
    if (requiredPermission) {
      assertHostPluginPermission(entry, requiredPermission)
    }
    // The `satisfies HostApiHandlerTable` typing guarantees a handler exists
    // for every target; this cast only bridges TypeScript's correlated-union
    // limitation (it can't tie `apiHandlers[msg.target]` to `msg`'s narrowed
    // shape), it does NOT mask a missing handler.
    const handler = apiHandlers[msg.target] as AnyHostApiHandler
    await handler(msg, entry, db)
  } catch (err) {
    replyApiError(msg.pluginId, msg.correlationId, err instanceof Error ? err.message : String(err))
  }
}
