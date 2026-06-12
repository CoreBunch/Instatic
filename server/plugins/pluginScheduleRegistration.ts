/**
 * Plugin schedule registration + cadence math — extracted from `scheduler.ts`
 * so the host API schedule handler can import `registerPluginSchedule`
 * statically without forming a cycle with the tick loop.
 *
 * Why this lives apart from `scheduler.ts`:
 *   - `scheduler.ts` imports `runScheduleInWorker` from `host/rpc` to fire
 *     the registered handler on each tick.
 *   - `host/handlers/schedule.ts` calls `registerPluginSchedule` when a plugin's
 *     `activate()` invokes `api.cms.schedule.register(...)`.
 *   - Keeping `registerPluginSchedule` in `scheduler.ts` would force one
 *     side of that edge to use a dynamic `await import(...)` — a band-aid
 *     fallow's circular-dependency rule still flags.
 *
 * What lives here:
 *   • `Weekday` index map for the cadence parser.
 *   • `computeNextRun(cadence, from)` — pure function, tested in isolation.
 *   • `registerPluginSchedule(db, reg)` — DB upsert that computes
 *     `next_run_at` from the cadence and namespaces the schedule id.
 *
 * `scheduler.ts` re-exports `computeNextRun` and `registerPluginSchedule`
 * so existing call sites and tests don't need to chase the move.
 */

import type { DbClient } from '../db/client'
import {
  upsertPluginSchedule,
  type Cadence,
  type OverlapPolicy,
} from '../repositories/pluginSchedules'

interface ScheduleRegistration {
  pluginId: string
  scheduleId: string
  cadence: Cadence
  overlap: OverlapPolicy
  maxDurationMs: number
}

const WEEKDAY_INDEX: Record<'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat', number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
} as const

/**
 * Compute when a schedule should fire next, given its cadence and a
 * reference time (`from`). UTC throughout — plugins author times as
 * `'HH:MM'` UTC, which keeps the math deterministic across daylight
 * saving changes and operator timezone moves.
 *
 * Exported for unit testing; the tick consumes it indirectly via the
 * `advanceNextRun` helper in `scheduler.ts`.
 */
export function computeNextRun(cadence: Cadence, from: Date): Date {
  switch (cadence.interval) {
    case 'every': {
      // Round UP to the next minute boundary multiple, so `every: 5min`
      // first fires at the next :05/:10/:15... regardless of when the
      // plugin was registered.
      const stepMs = cadence.minutes * 60_000
      const sinceEpoch = from.getTime()
      const next = Math.floor(sinceEpoch / stepMs) * stepMs + stepMs
      return new Date(next)
    }

    case 'hourly': {
      // Next top of the hour (UTC).
      const out = new Date(from)
      out.setUTCMinutes(0, 0, 0)
      out.setUTCHours(out.getUTCHours() + 1)
      return out
    }

    case 'daily': {
      const [hh, mm] = cadence.at.split(':').map((s) => Number(s))
      const out = new Date(from)
      out.setUTCHours(hh, mm, 0, 0)
      if (out.getTime() <= from.getTime()) out.setUTCDate(out.getUTCDate() + 1)
      return out
    }

    case 'weekly': {
      const [hh, mm] = cadence.at.split(':').map((s) => Number(s))
      const targetDow = WEEKDAY_INDEX[cadence.day]
      const out = new Date(from)
      out.setUTCHours(hh, mm, 0, 0)
      const fromDow = out.getUTCDay()
      let delta = (targetDow - fromDow + 7) % 7
      if (delta === 0 && out.getTime() <= from.getTime()) delta = 7
      out.setUTCDate(out.getUTCDate() + delta)
      return out
    }

    case 'monthly': {
      const [hh, mm] = cadence.at.split(':').map((s) => Number(s))
      const out = new Date(from)
      out.setUTCDate(cadence.dayOfMonth)
      out.setUTCHours(hh, mm, 0, 0)
      if (out.getTime() <= from.getTime()) {
        // Roll forward one calendar month — setUTCMonth handles year rollover.
        out.setUTCMonth(out.getUTCMonth() + 1)
      }
      return out
    }
  }
}

/**
 * Namespace a plugin-local schedule id under its plugin id — same
 * convention as routes, hooks, and loops (`<pluginId>.<localId>`).
 * Idempotent on already-namespaced ids. The single source of truth for
 * the convention on the host side; the VM bootstrap mirrors it in
 * `buildApi.ts:namespaceScheduleId` (the sandbox cannot import host code).
 *
 * BOTH register and cancel must run the caller-supplied id through this —
 * a cancel against the raw local id would match no row and the schedule
 * would fire forever.
 */
export function pluginScheduleFullId(pluginId: string, scheduleId: string): string {
  return scheduleId.startsWith(`${pluginId}.`) ? scheduleId : `${pluginId}.${scheduleId}`
}

/**
 * Upsert a schedule row from a plugin's `api.cms.schedule.register(...)`
 * call. Idempotent on re-activation: a second register with the same
 * (pluginId, scheduleId) keeps the row's last-run history but adopts the
 * new cadence + handler.
 */
export async function registerPluginSchedule(
  db: DbClient,
  reg: ScheduleRegistration,
): Promise<void> {
  const nextRunAt = computeNextRun(reg.cadence, new Date()).toISOString()
  await upsertPluginSchedule(db, {
    pluginId: reg.pluginId,
    scheduleId: pluginScheduleFullId(reg.pluginId, reg.scheduleId),
    cadence: reg.cadence,
    overlap: reg.overlap,
    maxDurationMs: reg.maxDurationMs,
    nextRunAt,
  })
}
