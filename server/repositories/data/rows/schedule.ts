/**
 * Scheduled-publish lifecycle for data rows.
 *
 *   scheduleDataRowPublish   — mark a row `scheduled` for a future publish
 *   cancelScheduledPublish   — revert a pending scheduled row to a draft
 *   listDuePublishSchedules  — read scheduled rows whose target time has passed
 *
 * The publish-scheduler tick (`server/publish/publishScheduler.ts`) polls
 * `listDuePublishSchedules` and calls the regular publish path on each result.
 */
import type { DbClient } from '../../../db/client'
import type { DataRow } from '@core/data/schemas'
import { isoDate } from '@core/utils/isoDate'
import { getDataRow } from './read'

/**
 * Mark a row as `scheduled` for future publication. The publish-scheduler
 * tick (`server/publish/publishScheduler.ts`) polls for rows where
 * `status='scheduled' AND scheduled_publish_at <= now()` and calls the
 * regular publish path on each.
 *
 *   • `whenIso` MUST be in the future — the caller (HTTP handler)
 *     validates this before invoking us. We don't re-validate here so a
 *     direct repo caller (tests, fixtures) can plant rows at any time.
 *
 *   • `published_at` / `published_by_user_id` are cleared because the
 *     row is no longer in the published state — they get repopulated
 *     when the tick actually publishes the row.
 *
 *   • `actorUserId` is recorded as the updater. We don't track "who
 *     scheduled this" separately — the audit log captures intent if
 *     a scheduling audit is ever needed.
 */
export async function scheduleDataRowPublish(
  db: DbClient,
  rowId: string,
  whenIso: string,
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set status = 'scheduled',
        scheduled_publish_at = ${whenIso},
        published_at = null,
        published_by_user_id = null,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  return rows[0] ? getDataRow(db, rows[0].id) : null
}

/**
 * Cancel a pending scheduled publication and revert the row to a draft.
 * Used by the "Cancel schedule" UI action and by the publish-scheduler
 * tick's failure handler (when a publish attempt fails the row falls
 * back to draft per CLAUDE.md "Revert to draft + log error" choice).
 */
export async function cancelScheduledPublish(
  db: DbClient,
  rowId: string,
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set status = 'draft',
        scheduled_publish_at = null,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
      and status = 'scheduled'
    returning id
  `
  return rows[0] ? getDataRow(db, rows[0].id) : null
}

/**
 * Lightweight read shape for the publish-scheduler tick — just the
 * identity columns it needs to dispatch a publish, no joined user refs
 * (the tick doesn't render any UI). One small ANSI-SQL query, the same
 * filter the partial index `data_rows_scheduled_publish_idx` covers.
 */
interface DueScheduledRow {
  rowId: string
  tableId: string
  scheduledPublishAt: string
}

/**
 * List scheduled rows whose target time has passed and that aren't
 * already deleted. Returns up to `limit` rows ordered by their target
 * time (oldest first — back-pressure favours the rows that have been
 * waiting longest). The scheduler tick calls this, then calls
 * `publishDataRow(...)` on each result.
 *
 * NOT atomic — two concurrent leader instances could read the same
 * batch. The publish-scheduler tick relies on the host-level leader
 * lock (`pg_try_advisory_lock` in PG, single-process for SQLite) to
 * ensure only one instance ticks at a time.
 */
export async function listDuePublishSchedules(
  db: DbClient,
  nowIso: string,
  limit: number,
): Promise<DueScheduledRow[]> {
  const { rows } = await db<{
    id: string
    table_id: string
    scheduled_publish_at: string | Date
  }>`
    select id, table_id, scheduled_publish_at
    from data_rows
    where status = 'scheduled'
      and deleted_at is null
      and scheduled_publish_at is not null
      and scheduled_publish_at <= ${nowIso}
    order by scheduled_publish_at asc
    limit ${limit}
  `
  return rows.map((row) => ({
    rowId: row.id,
    tableId: row.table_id,
    scheduledPublishAt: isoDate(row.scheduled_publish_at),
  }))
}
