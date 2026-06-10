/**
 * Plugin schedule handlers — implements cms.schedule.register and
 * cms.schedule.cancel api-calls.
 *
 * Both are gated by the `cms.schedule` permission, enforced centrally in
 * apiDispatch.ts (via TARGET_PERMISSIONS) before these handlers run. Registration delegates to
 * `pluginScheduleRegistration` which owns the DB upsert and next_run_at
 * calculation, keeping all cadence math in one place so registration and
 * tick share identical interpretation. Cancellation marks the schedule as
 * disabled in the database.
 */

import { pluginScheduleFullId, registerPluginSchedule } from '../../pluginScheduleRegistration'
import { disablePluginSchedule } from '../../../repositories/pluginSchedules'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'

export async function handleScheduleRegister(
  msg: ApiCallFor<'cms.schedule.register'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [arg] = msg.args
  await registerPluginSchedule(db, {
    pluginId: msg.pluginId,
    scheduleId: arg.scheduleId,
    cadence: arg.cadence,
    overlap: arg.overlap,
    maxDurationMs: arg.maxDurationMs,
  })
  replyApiOk(msg.pluginId, msg.correlationId)
}

export async function handleScheduleCancel(
  msg: ApiCallFor<'cms.schedule.cancel'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ scheduleId }] = msg.args
  // Registration stored the row under the namespaced id — cancel must
  // target the same key or it matches nothing.
  await disablePluginSchedule(db, msg.pluginId, pluginScheduleFullId(msg.pluginId, scheduleId))
  replyApiOk(msg.pluginId, msg.correlationId)
}
