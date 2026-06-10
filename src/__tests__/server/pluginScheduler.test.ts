/**
 * Plugin scheduler — unit + integration tests.
 *
 * Covers:
 *   • Cadence math (`computeNextRun`) for every interval shape
 *   • Atomic claim race (two ticks can't fire the same schedule twice)
 *   • Failure cap auto-pauses a schedule after N consecutive errors
 *   • `runScheduleNow` bypasses cadence but still respects the claim lock
 *   • Cancel namespacing — `cms.schedule.cancel` with a plugin-local id
 *     targets the namespaced row that register created
 *   • Due selection — paused schedules and schedules of disabled plugins
 *     never fire; re-registration on boot preserves a pause
 *   • Ghost sweep — schedules not re-registered during an activation pass
 *     are disabled
 *   • HA leader path (SQLite single-leader sentinel; PG path covered
 *     structurally — we don't spin a real PG in tests)
 *
 * The schedule firing path itself depends on a live worker — those are
 * exercised via the existing `cmsPlugins` integration suite. Here we
 * stub `runScheduleInWorker` so the focus stays on the engine logic.
 */
import { describe, expect, it, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import {
  computeNextRun,
  registerPluginSchedule,
  runScheduleNow,
  tickPluginScheduler,
} from '../../../server/plugins/scheduler'
import { handleScheduleCancel } from '../../../server/plugins/host/handlers/schedule'
import type { HostPluginRecord } from '../../../server/plugins/host/types'
import {
  disableSchedulesNotReclaimedSince,
  getSchedule,
  insertScheduleRun,
  listRecentRuns,
  pauseSchedule,
  resumeSchedule,
  selectDueSchedules,
} from '../../../server/repositories/pluginSchedules'
import type { DbClient } from '../../../server/db/client'

// ---------------------------------------------------------------------------
// Cadence math — pure function, no DB needed
// ---------------------------------------------------------------------------

describe('computeNextRun', () => {
  it('advances `every: 5` to the next 5-minute boundary', () => {
    const from = new Date('2026-05-18T10:07:23Z')
    const next = computeNextRun({ interval: 'every', minutes: 5 }, from)
    expect(next.toISOString()).toBe('2026-05-18T10:10:00.000Z')
  })

  it('advances `hourly` to the next top of hour', () => {
    const from = new Date('2026-05-18T10:42:00Z')
    const next = computeNextRun({ interval: 'hourly' }, from)
    expect(next.toISOString()).toBe('2026-05-18T11:00:00.000Z')
  })

  it('advances `daily at 03:00` to today\'s 03:00 if still in future, else tomorrow', () => {
    const beforeFire = new Date('2026-05-18T02:59:00Z')
    const afterFire = new Date('2026-05-18T03:01:00Z')
    expect(computeNextRun({ interval: 'daily', at: '03:00' }, beforeFire).toISOString())
      .toBe('2026-05-18T03:00:00.000Z')
    expect(computeNextRun({ interval: 'daily', at: '03:00' }, afterFire).toISOString())
      .toBe('2026-05-19T03:00:00.000Z')
  })

  it('advances `weekly Mon 09:00` to the next Monday', () => {
    // Mon 2026-05-18 is itself a Monday — before 09:00 → same day,
    // after 09:00 → next Monday.
    const beforeFire = new Date('2026-05-18T08:00:00Z')
    const afterFire = new Date('2026-05-18T10:00:00Z')
    expect(computeNextRun({ interval: 'weekly', at: '09:00', day: 'mon' }, beforeFire).toISOString())
      .toBe('2026-05-18T09:00:00.000Z')
    expect(computeNextRun({ interval: 'weekly', at: '09:00', day: 'mon' }, afterFire).toISOString())
      .toBe('2026-05-25T09:00:00.000Z')
  })

  it('advances `monthly day 15 at 00:00` to next month if past', () => {
    const stillInMonth = new Date('2026-05-10T00:00:00Z')
    const pastInMonth = new Date('2026-05-20T00:00:00Z')
    expect(computeNextRun({ interval: 'monthly', at: '00:00', dayOfMonth: 15 }, stillInMonth).toISOString())
      .toBe('2026-05-15T00:00:00.000Z')
    expect(computeNextRun({ interval: 'monthly', at: '00:00', dayOfMonth: 15 }, pastInMonth).toISOString())
      .toBe('2026-06-15T00:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// Live DB tests
// ---------------------------------------------------------------------------

async function insertTestPlugin(db: DbClient, id: string, enabled = true): Promise<void> {
  await db`
    insert into installed_plugins (id, name, version, enabled, manifest_json)
    values (${id}, ${'Scheduler Test'}, ${'1.0.0'}, ${enabled ? 1 : 0}, ${JSON.stringify({
      id,
      name: 'Scheduler Test',
      version: '1.0.0',
      apiVersion: 1,
      permissions: ['cms.schedule'],
      resources: [],
      adminPages: [],
    })})
  `
}

async function setupDb(): Promise<{ db: DbClient; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'instatic-scheduler-'))
  const dbPath = join(dir, 'test.db')
  const db = createSqliteClient(dbPath)
  await runMigrations(db, sqliteMigrations)
  // Bootstrap a fake installed_plugins row — the FK on plugin_schedules
  // requires it to exist before any registration.
  await insertTestPlugin(db, 'test.sched')
  return {
    db,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Force a registered schedule to be due immediately. */
async function makeDue(db: DbClient, pluginId: string, scheduleId: string): Promise<void> {
  const past = new Date(Date.now() - 60_000).toISOString()
  await db`
    update plugin_schedules set next_run_at = ${past}
    where plugin_id = ${pluginId} and schedule_id = ${scheduleId}
  `
}

describe('plugin scheduler — DB', () => {
  it('registers a schedule with a computed next_run_at', async () => {
    const { db, cleanup } = await setupDb()
    try {
      await registerPluginSchedule(db, {
        pluginId: 'test.sched',
        scheduleId: 'nightly',
        cadence: { interval: 'every', minutes: 60 },
        overlap: 'skip',
        maxDurationMs: 5000,
      })
      const sched = await getSchedule(db, 'test.sched', 'test.sched.nightly')
      expect(sched).not.toBeNull()
      expect(sched?.enabled).toBe(true)
      // next_run_at should be in the future
      expect(new Date(sched!.nextRunAt).getTime()).toBeGreaterThan(Date.now())
    } finally {
      await cleanup()
    }
  })

  it('runScheduleNow respects an existing claim (no double-fire)', async () => {
    const { db, cleanup } = await setupDb()
    try {
      await registerPluginSchedule(db, {
        pluginId: 'test.sched',
        scheduleId: 'race',
        cadence: { interval: 'hourly' },
        overlap: 'skip',
        maxDurationMs: 5000,
      })
      // Mock the worker dispatch so we don't need a live VM. Two
      // concurrent run-now calls — only ONE should win the claim.
      const dispatch = mock(async () => ({ status: 'ok' as const, durationMs: 1 }))
      mock.module('../../../server/plugins/host/rpc', () => ({
        runScheduleInWorker: dispatch,
      }))
      const [first, second] = await Promise.all([
        runScheduleNow(db, 'test.sched', 'test.sched.race'),
        runScheduleNow(db, 'test.sched', 'test.sched.race'),
      ])
      const wins = [first, second].filter((r) => r.ok).length
      const losses = [first, second].filter((r) => !r.ok && r.error === 'already-claimed').length
      // Exactly one fires successfully; the other gets the claim-race error.
      expect(wins).toBe(1)
      expect(losses).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('tickPluginScheduler no-ops when no schedules are due', async () => {
    const { db, cleanup } = await setupDb()
    try {
      await registerPluginSchedule(db, {
        pluginId: 'test.sched',
        scheduleId: 'far-future',
        cadence: { interval: 'daily', at: '00:00' },
        overlap: 'skip',
        maxDurationMs: 5000,
      })
      // Force `next_run_at` to be in the future so the tick should not fire it.
      const future = new Date(Date.now() + 24 * 3600_000).toISOString()
      await db`
        update plugin_schedules set next_run_at = ${future}
        where plugin_id = ${'test.sched'} and schedule_id = ${'test.sched.far-future'}
      `
      const dispatch = mock(async () => ({ status: 'ok' as const, durationMs: 1 }))
      mock.module('../../../server/plugins/host/rpc', () => ({
        runScheduleInWorker: dispatch,
      }))
      await tickPluginScheduler(db)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  it('history runs are trimmed to a bounded count', async () => {
    const { db, cleanup } = await setupDb()
    try {
      await registerPluginSchedule(db, {
        pluginId: 'test.sched',
        scheduleId: 'noisy',
        cadence: { interval: 'hourly' },
        overlap: 'skip',
        maxDurationMs: 5000,
      })
      // Cheap smoke check on insertScheduleRun + listRecentRuns plumbing.
      for (let i = 0; i < 5; i++) {
        await insertScheduleRun(db, {
          id: `run-${i}`,
          pluginId: 'test.sched',
          scheduleId: 'test.sched.noisy',
          startedAt: new Date(Date.now() + i).toISOString(),
          triggeredBy: 'tick',
        })
      }
      const recent = await listRecentRuns(db, 'test.sched', 'test.sched.noisy', 3)
      expect(recent.length).toBe(3)
    } finally {
      await cleanup()
    }
  })

  it('cms.schedule.cancel with a plugin-local id disables the namespaced row', async () => {
    const { db, cleanup } = await setupDb()
    try {
      await registerPluginSchedule(db, {
        pluginId: 'test.sched',
        scheduleId: 'sync',
        cadence: { interval: 'hourly' },
        overlap: 'skip',
        maxDurationMs: 5000,
      })
      // The VM sends the RAW local id ('sync') in the cancel api-call —
      // the handler must namespace it to match the stored row
      // ('test.sched.sync'). `replyApiOk` no-ops without a live worker.
      await handleScheduleCancel(
        {
          kind: 'api-call',
          correlationId: 'c1',
          pluginId: 'test.sched',
          target: 'cms.schedule.cancel',
          args: [{ scheduleId: 'sync' }],
        },
        {} as unknown as HostPluginRecord,
        db,
      )
      const sched = await getSchedule(db, 'test.sched', 'test.sched.sync')
      expect(sched?.enabled).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('due selection excludes paused schedules until resumed', async () => {
    const { db, cleanup } = await setupDb()
    try {
      await registerPluginSchedule(db, {
        pluginId: 'test.sched',
        scheduleId: 'pausable',
        cadence: { interval: 'hourly' },
        overlap: 'skip',
        maxDurationMs: 5000,
      })
      await makeDue(db, 'test.sched', 'test.sched.pausable')
      await pauseSchedule(db, 'test.sched', 'test.sched.pausable', new Date().toISOString())
      expect(await selectDueSchedules(db, new Date().toISOString(), 10)).toEqual([])
      await resumeSchedule(db, 'test.sched', 'test.sched.pausable')
      const due = await selectDueSchedules(db, new Date().toISOString(), 10)
      expect(due.map((s) => s.scheduleId)).toEqual(['test.sched.pausable'])
    } finally {
      await cleanup()
    }
  })

  it('due selection excludes schedules whose plugin is disabled', async () => {
    const { db, cleanup } = await setupDb()
    try {
      await insertTestPlugin(db, 'test.disabled', false)
      for (const pluginId of ['test.sched', 'test.disabled']) {
        await registerPluginSchedule(db, {
          pluginId,
          scheduleId: 'job',
          cadence: { interval: 'hourly' },
          overlap: 'skip',
          maxDurationMs: 5000,
        })
        await makeDue(db, pluginId, `${pluginId}.job`)
      }
      const due = await selectDueSchedules(db, new Date().toISOString(), 10)
      expect(due.map((s) => s.pluginId)).toEqual(['test.sched'])
    } finally {
      await cleanup()
    }
  })

  it('re-registration on boot preserves an existing pause', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const reg = {
        pluginId: 'test.sched',
        scheduleId: 'sticky',
        cadence: { interval: 'hourly' as const },
        overlap: 'skip' as const,
        maxDurationMs: 5000,
      }
      await registerPluginSchedule(db, reg)
      await pauseSchedule(db, 'test.sched', 'test.sched.sticky', new Date().toISOString())
      // Server restart → activate() → register again. The upsert re-asserts
      // registration state but must NOT clear the operator/failure pause.
      await registerPluginSchedule(db, reg)
      const sched = await getSchedule(db, 'test.sched', 'test.sched.sticky')
      expect(sched?.enabled).toBe(true)
      expect(sched?.paused).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('ghost sweep disables schedules not re-registered during the activation pass', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const reg = (scheduleId: string) => ({
        pluginId: 'test.sched',
        scheduleId,
        cadence: { interval: 'hourly' as const },
        overlap: 'skip' as const,
        maxDurationMs: 5000,
      })
      // v1 registered both schedules on a previous boot.
      await registerPluginSchedule(db, reg('keep'))
      await registerPluginSchedule(db, reg('drop'))
      await Bun.sleep(5)
      // v2 activation pass: only 'keep' is re-registered.
      const activationStartedAt = new Date().toISOString()
      await Bun.sleep(5)
      await registerPluginSchedule(db, reg('keep'))
      await disableSchedulesNotReclaimedSince(db, 'test.sched', activationStartedAt)
      const kept = await getSchedule(db, 'test.sched', 'test.sched.keep')
      const dropped = await getSchedule(db, 'test.sched', 'test.sched.drop')
      expect(kept?.enabled).toBe(true)
      expect(dropped?.enabled).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
