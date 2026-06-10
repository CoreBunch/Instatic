/**
 * Plugin schedules dialog — shows every scheduled job a plugin has
 * registered, plus recent run history, plus per-schedule controls
 * (Run now / Pause / Resume).
 *
 * Flow:
 *   1. Open dialog → fetch `GET /admin/api/cms/plugins/:id/schedules`
 *   2. User clicks an action button → wrapped in `runStepUp` so the
 *      server-side step-up requirement (set on run-now / pause / resume
 *      in `server/handlers/cms/plugins/index.ts:requiresStepUp`) becomes
 *      a password-confirm prompt instead of a raw 401.
 *   3. After any mutation, the schedule list is re-fetched so the row
 *      shows the new state immediately.
 *
 * Built on the shared `<Dialog/>` primitive; uses `pluginAdminUi.*`
 * primitives for visual consistency with the other plugin dialogs.
 */
import { useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import {
  listCmsPluginSchedules,
  pauseCmsPluginSchedule,
  resumeCmsPluginSchedule,
  runCmsPluginScheduleNow,
  type CmsPluginScheduleRunSummary,
  type CmsPluginScheduleSummary,
} from '@core/persistence'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { pluginAdminUi } from '../PluginAdminUi'
import styles from './PluginSchedulesDialog.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

// ---------------------------------------------------------------------------
// Module-level helper — extracted so the React Compiler can auto-memoize the
// component body (try/catch in async causes compiler bailout when nested inside
// a component function).
// ---------------------------------------------------------------------------

async function runScheduleAction<T>(
  scheduleId: string,
  action: () => Promise<T>,
  runStepUp: (action: () => Promise<T>) => Promise<T>,
  setBusyScheduleId: (id: string | null) => void,
  setActionError: (err: string | null) => void,
  refresh: () => void,
): Promise<void> {
  setBusyScheduleId(scheduleId)
  setActionError(null)
  try {
    await runStepUp(action)
    refresh()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) return
    setActionError(getErrorMessage(err, 'Action failed'))
  } finally {
    setBusyScheduleId(null)
  }
}

interface PluginSchedulesDialogProps {
  pluginId: string
  pluginName: string
  onClose: () => void
}

export function PluginSchedulesDialog({ pluginId, pluginName, onClose }: PluginSchedulesDialogProps) {
  const { runStepUp } = useStepUp()
  const {
    data,
    loading,
    error: loadError,
    refresh,
  } = useAsyncResource(() => listCmsPluginSchedules(pluginId), [pluginId], {
    fallbackError: 'Failed to load schedules',
  })
  const [busyScheduleId, setBusyScheduleId] = useState<string | null>(null)
  // Errors from Run-now / Pause / Resume actions live alongside the load
  // error from the resource; the view shows whichever is present.
  const [actionError, setActionError] = useState<string | null>(null)
  const error = loadError ?? actionError

  async function withStepUp<T>(scheduleId: string, action: () => Promise<T>): Promise<void> {
    await runScheduleAction(scheduleId, action, runStepUp, setBusyScheduleId, setActionError, refresh)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Scheduled jobs"
      title={pluginName}
      size="lg"
      loading={loading}
    >
      {error && (
        <pluginAdminUi.Alert tone="danger" title="Could not load schedules">
          {error}
        </pluginAdminUi.Alert>
      )}

      {!loading && data && data.schedules.length === 0 && (
        <pluginAdminUi.EmptyState
          title="No schedules registered"
          body="This plugin has not called api.cms.schedule.register() during activate. Schedules show up here automatically once a plugin registers them."
        />
      )}

      {!loading && data && data.schedules.length > 0 && (
        <pluginAdminUi.Stack gap={12}>
          {data.schedules.map((sched) => (
            <ScheduleRow
              key={sched.scheduleId}
              schedule={sched}
              recent={data.recent[sched.scheduleId] ?? []}
              busy={busyScheduleId === sched.scheduleId}
              onRunNow={() =>
                withStepUp(sched.scheduleId, () =>
                  runCmsPluginScheduleNow(pluginId, sched.scheduleId),
                )
              }
              onPause={() =>
                withStepUp(sched.scheduleId, () => pauseCmsPluginSchedule(pluginId, sched.scheduleId))
              }
              onResume={() =>
                withStepUp(sched.scheduleId, () => resumeCmsPluginSchedule(pluginId, sched.scheduleId))
              }
            />
          ))}
        </pluginAdminUi.Stack>
      )}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// One schedule row
// ---------------------------------------------------------------------------

interface ScheduleRowProps {
  schedule: CmsPluginScheduleSummary
  recent: CmsPluginScheduleRunSummary[]
  busy: boolean
  onRunNow: () => void
  onPause: () => void
  onResume: () => void
}

function ScheduleRow({ schedule, recent, busy, onRunNow, onPause, onResume }: ScheduleRowProps) {
  return (
    <div className={styles.scheduleRow}>
      <div className={styles.scheduleHeader}>
        <h4 className={styles.scheduleTitle}>{schedule.scheduleId}</h4>
        <StatusBadge schedule={schedule} />
      </div>

      <dl className={styles.scheduleMeta}>
        <dt>Cadence</dt>
        <dd>{cadenceLabel(schedule.cadence)}</dd>
        <dt>Last run</dt>
        <dd>{schedule.lastRunAt ? formatDateTime(schedule.lastRunAt) : '—'}</dd>
        <dt>Next run</dt>
        <dd>
          {!schedule.enabled
            ? '— (cancelled)'
            : schedule.paused
              ? '— (paused)'
              : formatDateTime(schedule.nextRunAt)}
        </dd>
        {schedule.consecutiveFailures > 0 && (
          <>
            <dt>Failures</dt>
            <dd>{schedule.consecutiveFailures} in a row</dd>
          </>
        )}
      </dl>

      {schedule.lastError && <p className={styles.errorLine}>{schedule.lastError}</p>}

      {/* A cancelled schedule (enabled=false) has no live registration — the
          plugin owns that state, so the admin gets no controls for it. */}
      {schedule.enabled && (
        <div className={styles.scheduleActions}>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={onRunNow}
            disabled={busy}
          >
            {busy ? 'Working...' : 'Run now'}
          </Button>
          {schedule.paused ? (
            <Button variant="secondary" size="sm" type="button" onClick={onResume} disabled={busy}>
              Resume
            </Button>
          ) : (
            <Button variant="secondary" size="sm" type="button" onClick={onPause} disabled={busy}>
              Pause
            </Button>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <>
          <h5 className={styles.recentRunsHeading}>Recent runs</h5>
          <ul className={styles.recentRuns}>
            {recent.slice(0, 5).map((run) => (
              <li key={run.id} data-status={run.status}>
                <span>{formatDateTime(run.startedAt)}</span>
                <span>{run.error ?? formatStatus(run.status)}</span>
                <span>{run.durationMs != null ? `${run.durationMs}ms` : '—'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function StatusBadge({ schedule }: { schedule: CmsPluginScheduleSummary }) {
  if (!schedule.enabled) {
    return <span className={`${styles.statusBadge} ${styles.statusPaused}`}>Cancelled</span>
  }
  if (schedule.paused) {
    return <span className={`${styles.statusBadge} ${styles.statusPaused}`}>Paused</span>
  }
  switch (schedule.lastStatus) {
    case 'ok':
      return <span className={`${styles.statusBadge} ${styles.statusOk}`}>Healthy</span>
    case 'error':
      return <span className={`${styles.statusBadge} ${styles.statusError}`}>Error</span>
    case 'timeout':
      return <span className={`${styles.statusBadge} ${styles.statusTimeout}`}>Timeout</span>
    default:
      return <span className={`${styles.statusBadge} ${styles.statusNever}`}>Pending</span>
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatStatus(status: string): string {
  if (status === 'ok') return 'Completed'
  if (status === 'error') return 'Failed'
  if (status === 'timeout') return 'Timed out'
  return 'Pending'
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Render a cadence shape as a human-readable string. Mirrors the SDK
 * `PluginScheduleCadence` union — kept on the client so we don't make
 * a server round-trip just to format a label.
 */
function cadenceLabel(cadence: unknown): string {
  if (!cadence || typeof cadence !== 'object') return 'unknown'
  const c = cadence as Record<string, unknown>
  switch (c.interval) {
    case 'hourly':
      return 'Every hour'
    case 'daily':
      return `Daily at ${String(c.at)} UTC`
    case 'weekly':
      return `Weekly on ${String(c.day)} at ${String(c.at)} UTC`
    case 'monthly':
      return `Monthly on day ${String(c.dayOfMonth)} at ${String(c.at)} UTC`
    case 'every':
      return `Every ${String(c.minutes)} minute${c.minutes === 1 ? '' : 's'}`
    default:
      return 'unknown'
  }
}
