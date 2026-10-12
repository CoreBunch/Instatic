/**
 * Redirect plugin handlers — implement the `cms.redirects.*` api-calls over
 * the plugin-owned redirect table.
 *
 * Every target is gated by `redirects.manage`, enforced centrally in
 * apiDispatch.ts (via TARGET_PERMISSIONS) before these handlers run. Every
 * repository call is scoped to `msg.pluginId`, so a plugin only ever sees,
 * changes, or deletes its own rules.
 *
 * The handlers map the SDK shape (`from` / `to`) to the repository shape
 * (`fromPath` / `toLocation`) and back. Validation lives in the repository;
 * a `PluginRedirectValidationError` is replied as `<field>: <message>` so
 * the plugin learns which field was wrong.
 */

import type { PluginRedirectRule, PluginRedirectRuleInput } from '@core/plugin-sdk'
import {
  PluginRedirectValidationError,
  deletePluginRedirect,
  listPluginRedirects,
  replacePluginRedirects,
  setPluginRedirect,
  type PluginRedirectInput,
  type PluginRedirectRow,
} from '../../../repositories/pluginRedirects'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiError, replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'

function toRepositoryInput(rule: PluginRedirectRuleInput): PluginRedirectInput {
  return { fromPath: rule.from, toLocation: rule.to ?? null, status: rule.status }
}

function toSdkRule(row: PluginRedirectRow): PluginRedirectRule {
  return {
    from: row.fromPath,
    to: row.toLocation,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Runs a repository call and replies. Validation errors become
 * `<field>: <message>` replies; anything else bubbles to the dispatcher's
 * generic error reply.
 */
async function replyWith(
  msg: { pluginId: string; correlationId: string },
  run: () => Promise<unknown>,
): Promise<void> {
  let value: unknown
  try {
    value = await run()
  } catch (err) {
    if (err instanceof PluginRedirectValidationError) {
      replyApiError(msg.pluginId, msg.correlationId, `${err.field}: ${err.message}`)
      return
    }
    throw err
  }
  replyApiOk(msg.pluginId, msg.correlationId, value)
}

export async function handleRedirectsList(
  msg: ApiCallFor<'cms.redirects.list'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  await replyWith(msg, async () => (await listPluginRedirects(db, msg.pluginId)).map(toSdkRule))
}

export async function handleRedirectsSet(
  msg: ApiCallFor<'cms.redirects.set'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [rule] = msg.args
  await replyWith(msg, async () => toSdkRule(await setPluginRedirect(db, msg.pluginId, toRepositoryInput(rule))))
}

export async function handleRedirectsDelete(
  msg: ApiCallFor<'cms.redirects.delete'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [from] = msg.args
  await replyWith(msg, () => deletePluginRedirect(db, msg.pluginId, from))
}

export async function handleRedirectsReplaceAll(
  msg: ApiCallFor<'cms.redirects.replaceAll'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [rules] = msg.args
  await replyWith(msg, () => replacePluginRedirects(db, msg.pluginId, rules.map(toRepositoryInput)))
}
