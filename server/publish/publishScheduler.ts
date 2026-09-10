/** Scheduled language publications keep their existing live version on failure. */
import type { DbClient } from '../db/client'
import { withSchedulerLeaderLock } from '../db/advisoryLock'
import { publishDataRow } from './publishRow'
import { emitContentEntryUpdated } from './contentEvents'
import {
  cancelScheduledPublish,
  listDuePublishSchedules,
} from '../repositories/data/rows'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How often the leader instance polls for due scheduled rows. 10s
 * matches the plugin scheduler — the tradeoff is "how late can a
 * scheduled publish be before the user notices". Faster = more DB
 * polling, slower = visible publish lag. 10s feels human-correct.
 */
const TICK_INTERVAL_MS = 10_000

/**
 * Max scheduled rows pulled per tick. Bounded so one tick can't starve
 * the next if hundreds of rows are scheduled for the same minute (e.g.
 * "publish my whole content backlog at noon Monday"). Excess rows are
 * picked up on the next tick.
 */
const TICK_BATCH_LIMIT = 25

/**
 * Postgres advisory-lock key — must be a bigint. Distinct from the
 * plugin scheduler's key (712830541) so the two locks don't interfere
 * with each other. Derived from djb2('instatic-publish-scheduler')
 * mod 2^31.
 */
const ADVISORY_LOCK_KEY = 982410937

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

let tickTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the publish-scheduler tick. Idempotent — calling it twice on
 * the same process is a no-op. Pair with `server/plugins/scheduler.ts`'s
 * `startScheduler` in the boot path.
 */
export function startPublishScheduler(db: DbClient, uploadsDir?: string): void {
  if (tickTimer !== null) return
  tickTimer = setInterval(() => {
    void tickPublishScheduler(db, uploadsDir).catch((err) => {
      console.error('[publish-scheduler] tick failed:', err)
    })
  }, TICK_INTERVAL_MS)
}

/**
 * One iteration of the tick. Exported for tests — production code uses
 * `startPublishScheduler` and lets `setInterval` drive.
 */
export async function tickPublishScheduler(db: DbClient, uploadsDir?: string): Promise<void> {
  await withSchedulerLeaderLock(db, ADVISORY_LOCK_KEY, '[publish-scheduler]', async () => {
    const due = await listDuePublishSchedules(db, new Date().toISOString(), TICK_BATCH_LIMIT)
    for (const entry of due) {
      await fireOne(db, entry, uploadsDir)
    }
  })
}

async function fireOne(
  db: DbClient, entry: Awaited<ReturnType<typeof listDuePublishSchedules>>[number], uploadsDir?: string,
): Promise<void> {
  try {
    await publishDataRow(db, entry.rowId, null, uploadsDir, { localeId: entry.localeId, revision: entry.scheduledRevision })
    await emitContentEntryUpdated(db, entry.rowId, ['status'], { kind: 'system' }, entry.localeId)
  } catch (err) {
    console.error(`[publish-scheduler] failed to publish ${entry.rowId}/${entry.localeId}:`, err)
    // Cancel only this pending schedule; an older online version stays online.
    await cancelScheduledPublish(db, entry.rowId, null, entry.localeId).catch((cancelErr) => {
      console.error(`[publish-scheduler] failed to cancel ${entry.rowId}/${entry.localeId}:`, cancelErr)
    })
  }
}
