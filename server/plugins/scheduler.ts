/**
 * Plugin schedule tick loop — drives `api.cms.schedule.*` registrations
 * to actually fire at the cadence the plugin declared.
 *
 * Responsibilities:
 *
 *   1. **Cadence math** — compute the next `next_run_at` from a `Cadence`
 *      shape. Pure function; tested in isolation.
 *
 *   2. **Registration** — `registerPluginSchedule(db, ...)` upserts the
 *      schedule row, computes `next_run_at` if missing, and marks the
 *      schedule as "claimed" by a live VM handler. Called from the
 *      `host/apiDispatch.ts` schedule handler when the plugin invokes
 *      `api.cms.schedule.register({...})` during `activate()`.
 *
 *   3. **Tick** — every `TICK_INTERVAL_MS` (default 10s), select due
 *      schedules and dispatch each to its plugin's worker. Atomic claim
 *      via `tryClaimSchedule` so two HA instances can't fire the same
 *      schedule twice. The shared leader-election layer
 *      (`withSchedulerLeaderLock` in `server/db/advisoryLock.ts`) is the
 *      FIRST gate; per-row claim is the second.
 *
 *   4. **HA leader election** — via the shared `withSchedulerLeaderLock`
 *      (`server/db/advisoryLock.ts`), so only ONE host instance ticks at a
 *      time when running against Postgres. Against SQLite (single-instance by
 *      definition) this is a no-op. The lock is released between ticks so a
 *      leader crash hands off naturally to the next tick on another instance.
 *
 *   5. **Failure cap + auto-pause** — after FAILURE_CAP consecutive
 *      failures, the schedule is paused (`paused = true`, independent of
 *      the registration-owned `enabled` flag, so the pause survives
 *      restarts) and the operator must explicitly resume from the admin UI.
 *
 * Plugin authors do NOT interact with this module directly. The cadence
 * math, the lock dance, and the dispatch wire format are all contained
 * here so the rest of the system can stay ignorant of scheduling.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { withSchedulerLeaderLock } from '../db/advisoryLock'
import {
  finalizeScheduleRun,
  insertScheduleRun,
  listSchedulesForPlugin,
  markScheduleRunStarted,
  pauseSchedule,
  recordScheduleRunOutcome,
  selectDueSchedules,
  trimScheduleRunHistory,
  tryClaimSchedule,
  type PluginSchedule,
  type ScheduleStatus,
} from '../repositories/pluginSchedules'
import { runScheduleInWorker } from './host/rpc'
import { computeNextRun, registerPluginSchedule } from './pluginScheduleRegistration'

// Re-export so existing call sites (admin handlers, tests) keep their
// `from './scheduler'` imports working without chasing the module split.
export { computeNextRun, registerPluginSchedule }

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** How often the leader instance polls for due schedules. */
const TICK_INTERVAL_MS = 10_000
/** Max schedules pulled per tick — bounded so one tick can't starve the next. */
const TICK_BATCH_LIMIT = 50
/** Plugin's claim is auto-released after `maxDurationMs * 2` so a crashed worker doesn't deadlock the row. */
const LOCK_MULTIPLIER = 2
/** Auto-pause threshold. After this many consecutive failures, the row flips `paused=true`. */
const FAILURE_CAP = 5
/** Postgres advisory-lock key — must be a bigint. Derived from the string below for human readability. */
const ADVISORY_LOCK_KEY = 712830541 // = djb2('instatic-plugin-scheduler') mod 2^31
/** Run-history rolling trim runs at most this often (don't churn every tick). */
const HISTORY_TRIM_INTERVAL_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Manually fire a schedule from the admin UI's "Run now" button. Bypasses
 * `next_run_at` but still respects the claim lock — if another tick is
 * already running this schedule, the run-now call returns immediately
 * with the current status.
 */
export async function runScheduleNow(
  db: DbClient,
  pluginId: string,
  scheduleId: string,
): Promise<{ ok: boolean; status: ScheduleStatus; error?: string; durationMs: number }> {
  const schedules = await listSchedulesForPlugin(db, pluginId)
  const sched = schedules.find((s) => s.scheduleId === scheduleId)
  if (!sched) return { ok: false, status: 'error', error: 'schedule not found', durationMs: 0 }
  return await fireSchedule(db, sched, 'run-now')
}

// ---------------------------------------------------------------------------
// Cadence math
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

let tickTimer: ReturnType<typeof setInterval> | null = null
let lastHistoryTrimAt = 0

/**
 * Start the scheduler tick. Idempotent — calling it twice is a no-op.
 * Called from `runtime.ts:activateInstalledServerPlugins` on every boot
 * + re-bind so the tick is always pointed at the current DbClient.
 */
export function startScheduler(db: DbClient): void {
  if (tickTimer !== null) return
  tickTimer = setInterval(() => {
    void tickPluginScheduler(db).catch((err) => {
      console.error('[plugin-scheduler] tick failed:', err)
    })
  }, TICK_INTERVAL_MS)
}

/**
 * One iteration of the tick. Exported for tests — production code uses
 * `startScheduler` and lets `setInterval` drive.
 *
 * Race shape:
 *   ┌── leader election (advisory lock)
 *   │     ↓ acquired
 *   │     select due schedules
 *   │     for each:
 *   │       try row-level claim (`running_token` flip)
 *   │       ↓ won
 *   │       fire handler in plugin's worker
 *   │       record outcome (status, duration, advance next_run_at, decrement/reset failures, maybe pause)
 *   │     release advisory lock
 *   └── (next instance ticks next interval)
 */
export async function tickPluginScheduler(db: DbClient): Promise<void> {
  await withSchedulerLeaderLock(db, ADVISORY_LOCK_KEY, '[plugin-scheduler]', async () => {
    const now = new Date()
    // `selectDueSchedules` already filters to enabled, un-paused schedules
    // of enabled plugins — no re-check needed here.
    const due = await selectDueSchedules(db, now.toISOString(), TICK_BATCH_LIMIT)
    for (const sched of due) {
      await fireSchedule(db, sched, 'tick')
    }
    // Cheap rolling trim — keeps `plugin_schedule_runs` bounded without
    // hitting it every tick.
    if (Date.now() - lastHistoryTrimAt > HISTORY_TRIM_INTERVAL_MS) {
      lastHistoryTrimAt = Date.now()
      await trimScheduleRunHistory(db).catch((err) => {
        console.error('[plugin-scheduler] history trim failed:', err)
      })
    }
  })
}

// ---------------------------------------------------------------------------
// Schedule firing
// ---------------------------------------------------------------------------

async function fireSchedule(
  db: DbClient,
  sched: PluginSchedule,
  trigger: 'tick' | 'run-now',
): Promise<{ ok: boolean; status: ScheduleStatus; error?: string; durationMs: number }> {
  const now = new Date()
  const nowIso = now.toISOString()
  const token = nanoid()
  const lockUntilIso = new Date(now.getTime() + sched.maxDurationMs * LOCK_MULTIPLIER).toISOString()
  // Atomic claim — if another tick (or another HA instance) is ahead of
  // us, this returns false and we move on. Two ticks cannot fire the
  // same schedule simultaneously.
  const claimed = await tryClaimSchedule(db, sched.pluginId, sched.scheduleId, token, lockUntilIso, nowIso)
  if (!claimed) return { ok: false, status: 'error', error: 'already-claimed', durationMs: 0 }

  const runId = nanoid()
  await insertScheduleRun(db, {
    id: runId,
    pluginId: sched.pluginId,
    scheduleId: sched.scheduleId,
    startedAt: nowIso,
    triggeredBy: trigger,
  })
  await markScheduleRunStarted(db, sched.pluginId, sched.scheduleId, nowIso)

  let outcome: { ok: boolean; status: 'ok' | 'error' | 'timeout'; error?: string; durationMs: number }
  try {
    const result = await runScheduleInWorker({
      pluginId: sched.pluginId,
      scheduleId: sched.scheduleId,
      maxDurationMs: sched.maxDurationMs,
    })
    outcome = { ok: result.status === 'ok', status: result.status, error: result.error, durationMs: result.durationMs }
  } catch (err) {
    // Worker postMessage failed (e.g. worker died mid-call) — treat as a
    // logical error and keep the schedule alive so the next tick retries.
    outcome = {
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      durationMs: 0,
    }
  }

  const finishedAt = new Date()
  const finishedIso = finishedAt.toISOString()
  await finalizeScheduleRun(db, runId, {
    finishedAt: finishedIso,
    status: outcome.status,
    error: outcome.error ?? null,
    durationMs: outcome.durationMs,
  })

  const nextRunAt = computeNextRun(sched.cadence, finishedAt).toISOString()
  await recordScheduleRunOutcome(db, {
    pluginId: sched.pluginId,
    scheduleId: sched.scheduleId,
    token,
    nowIso: finishedIso,
    status: outcome.status,
    error: outcome.error ?? null,
    durationMs: outcome.durationMs,
    nextRunAt,
    resetFailures: outcome.ok,
  })

  if (!outcome.ok) {
    const nextFailures = sched.consecutiveFailures + 1
    if (nextFailures >= FAILURE_CAP) {
      await pauseSchedule(db, sched.pluginId, sched.scheduleId, finishedIso)
      console.error(
        `[plugin-scheduler] ${sched.pluginId}/${sched.scheduleId} paused after ${nextFailures} consecutive failures (last: ${outcome.error ?? 'unknown'})`,
      )
    }
  }

  return outcome
}
