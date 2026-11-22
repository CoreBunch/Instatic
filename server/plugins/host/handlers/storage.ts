/**
 * Plugin storage handlers — implement the `cms.storage.*` api-calls over
 * `plugin_records`.
 *
 * All of them are gated by the `cms.storage` permission, enforced centrally
 * in apiDispatch.ts (via TARGET_PERMISSIONS) before these handlers run. Every
 * call is scoped to the calling plugin's id and the resource id, so a plugin
 * can neither read nor collide with another plugin's records or keys. Record
 * data is validated against the plugin's resource schema when the manifest
 * declares the resource.
 *
 * Refusals a plugin must tell apart travel as message prefixes
 * (`storage_duplicate:`, `storage_conflict:`): the plugin RPC carries only a
 * message string.
 */

import { nanoid } from 'nanoid'
import { STORAGE_CONFLICT_PREFIX, STORAGE_DUPLICATE_PREFIX, type PluginResource } from '@core/plugin-sdk'
import {
  deriveRecordUniqueKey,
  findPluginResource,
  pluginRecordUniqueKey,
  validatePluginRecordData,
} from '@core/plugins/manifest'
import {
  PluginRecordConflictError,
  PluginRecordDuplicateError,
  createPluginRecord,
  createPluginRecordIfAbsent,
  deletePluginRecord,
  getPluginRecord,
  getPluginRecordByKey,
  listPluginRecords,
  updatePluginRecord,
} from '../../../repositories/pluginRecords'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'

/** Validate against the declared resource (if any) and derive the unique key. */
function prepareRecord(
  resource: PluginResource | null,
  data: Record<string, unknown>,
): { data: Record<string, unknown>; uniqueKey: string | null } {
  const cleaned = resource ? validatePluginRecordData(resource, data) : data
  return { data: cleaned, uniqueKey: pluginRecordUniqueKey(resource, cleaned) }
}

/** Re-throw a repository refusal as the prefixed message plugins match on. */
function rethrowStorageRefusal(err: unknown): never {
  if (err instanceof PluginRecordDuplicateError) {
    throw new Error(`${STORAGE_DUPLICATE_PREFIX} ${err.message}`, { cause: err })
  }
  if (err instanceof PluginRecordConflictError) {
    throw new Error(`${STORAGE_CONFLICT_PREFIX} ${err.message}`, { cause: err })
  }
  throw err
}

export async function handleStorageList(
  msg: ApiCallFor<'cms.storage.list'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [resourceId, options] = msg.args
  const result = await listPluginRecords(db, msg.pluginId, resourceId, options)
  replyApiOk(msg.pluginId, msg.correlationId, result as unknown)
}

export async function handleStorageGet(
  msg: ApiCallFor<'cms.storage.get'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [resourceId, recordId] = msg.args
  const record = await getPluginRecord(db, { pluginId: msg.pluginId, resourceId }, recordId)
  replyApiOk(msg.pluginId, msg.correlationId, record as unknown)
}

export async function handleStorageGetByKey(
  msg: ApiCallFor<'cms.storage.getByKey'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [resourceId, key] = msg.args
  requireUniqueField(findPluginResource(entry.manifest, resourceId), resourceId, 'getByKey')
  // Derived like a stored key (trimmed), so a lookup finds what a write stored.
  const uniqueKey = deriveRecordUniqueKey(key)
  const record = uniqueKey === null
    ? null
    : await getPluginRecordByKey(db, { pluginId: msg.pluginId, resourceId }, uniqueKey)
  replyApiOk(msg.pluginId, msg.correlationId, record as unknown)
}

export async function handleStorageCreate(
  msg: ApiCallFor<'cms.storage.create'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [resourceId, data] = msg.args
  const record = prepareRecord(findPluginResource(entry.manifest, resourceId), data)
  try {
    const created = await createPluginRecord(db, {
      id: nanoid(),
      pluginId: msg.pluginId,
      resourceId,
      ...record,
    })
    replyApiOk(msg.pluginId, msg.correlationId, created as unknown)
  } catch (err) {
    rethrowStorageRefusal(err)
  }
}

export async function handleStorageCreateIfAbsent(
  msg: ApiCallFor<'cms.storage.createIfAbsent'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [resourceId, data] = msg.args
  const { resource, uniqueField } = requireUniqueField(
    findPluginResource(entry.manifest, resourceId),
    resourceId,
    'createIfAbsent',
  )
  const record = prepareRecord(resource, data)
  if (record.uniqueKey === null) {
    throw new Error(
      `createIfAbsent needs a value for "${uniqueField}", the unique field of "${resourceId}"`,
    )
  }
  const result = await createPluginRecordIfAbsent(db, {
    id: nanoid(),
    pluginId: msg.pluginId,
    resourceId,
    data: record.data,
    uniqueKey: record.uniqueKey,
  })
  replyApiOk(msg.pluginId, msg.correlationId, result as unknown)
}

export async function handleStorageUpdate(
  msg: ApiCallFor<'cms.storage.update'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [resourceId, recordId, data, options] = msg.args
  const record = prepareRecord(findPluginResource(entry.manifest, resourceId), data)
  try {
    const updated = await updatePluginRecord(db, {
      id: recordId,
      pluginId: msg.pluginId,
      resourceId,
      ...record,
      ifVersion: options.ifVersion,
    })
    replyApiOk(msg.pluginId, msg.correlationId, updated as unknown)
  } catch (err) {
    rethrowStorageRefusal(err)
  }
}

export async function handleStorageDelete(
  msg: ApiCallFor<'cms.storage.delete'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [resourceId, recordId, options] = msg.args
  try {
    const ok = await deletePluginRecord(db, {
      id: recordId,
      pluginId: msg.pluginId,
      resourceId,
      ifVersion: options.ifVersion,
    })
    replyApiOk(msg.pluginId, msg.correlationId, ok as unknown)
  } catch (err) {
    rethrowStorageRefusal(err)
  }
}

/** The resource and its unique field, or a clear error naming the method. */
function requireUniqueField(
  resource: PluginResource | null,
  resourceId: string,
  method: string,
): { resource: PluginResource; uniqueField: string } {
  if (!resource?.uniqueField) {
    throw new Error(`${method} needs a uniqueField on the "${resourceId}" resource in the plugin manifest`)
  }
  return { resource, uniqueField: resource.uniqueField }
}
