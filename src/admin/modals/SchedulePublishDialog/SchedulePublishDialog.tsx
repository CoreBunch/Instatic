/**
 * SchedulePublishDialog — picks a future datetime and POSTs it to the
 * data-row `/schedule` endpoint.
 *
 * Shared by the Site/Pages publish menu (`PublishButton`) and the
 * Content/Posts publish menu (`ContentToolbar`). The caller passes:
 *   • the `rowId` of the page/post being scheduled
 *   • the current `scheduledAt` (or null) so re-opening the dialog
 *     pre-fills the picker with the existing schedule
 *   • an `onScheduled` callback fired after a successful schedule/cancel
 *     so the caller can refresh its derived UI (status badge, etc.)
 *
 * No retry / failure UI: the picker rejects past timestamps client-side
 * before hitting the network, and server-side errors surface as a brief
 * toast and the dialog stays open so the user can retry.
 */
import { useRef, useState } from 'react'
import {
  scheduleCmsDataRowPublish,
  cancelCmsDataRowSchedule,
} from '@core/persistence'
import type { DataRow } from '@core/data/schemas'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { DateTimePicker } from '@ui/components/DateTimePicker'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import styles from './SchedulePublishDialog.module.css'

interface SchedulePublishDialogProps {
  open: boolean
  onClose: () => void
  rowId: string
  localeId?: string
  /**
   * Existing scheduled time (ISO datetime) if the row is already
   * `'scheduled'`. Pre-fills the picker so re-opening the dialog shows
   * the user what they currently have set.
   */
  currentScheduledAt: string | null
  /** Human label used in the dialog title ("page", "post"). */
  entityLabel: string
  /** Fires after a successful schedule OR cancel so the caller can
   *  refresh its publish-status derived UI. */
  onScheduled: (row: DataRow) => void
}

// ---------------------------------------------------------------------------
// Module-level helpers (extracted so the React Compiler can compile the
// component body — try/finally inside an async function prevents compilation).
// ---------------------------------------------------------------------------

async function schedulePublish(
  rowId: string,
  next: Date,
  setBusy: (v: boolean) => void,
  setError: (msg: string | null) => void,
  onScheduled: (row: DataRow) => void,
  onClose: () => void,
  localeId: string | undefined,
  runStepUp: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    const row = await runStepUp(() => scheduleCmsDataRowPublish(rowId, next.toISOString(), undefined, undefined, localeId))
    onScheduled(row)
    onClose()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) return
    console.error('[schedule-dialog] Schedule failed:', err)
    const message = getErrorMessage(err, 'Failed to schedule publish')
    pushToast({ kind: 'error', title: 'Could not schedule publication', body: message })
  } finally {
    setBusy(false)
  }
}

async function cancelSchedule(
  rowId: string,
  setBusy: (v: boolean) => void,
  setError: (msg: string | null) => void,
  onScheduled: (row: DataRow) => void,
  onClose: () => void,
  localeId: string | undefined,
  runStepUp: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    const row = await runStepUp(() => cancelCmsDataRowSchedule(rowId, undefined, undefined, localeId))
    onScheduled(row)
    onClose()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) return
    console.error('[schedule-dialog] Cancel schedule failed:', err)
    const message = getErrorMessage(err, 'Failed to cancel schedule')
    pushToast({ kind: 'error', title: 'Could not cancel publication', body: message })
  } finally {
    setBusy(false)
  }
}

export function SchedulePublishDialog({
  open,
  onClose,
  rowId,
  localeId,
  currentScheduledAt,
  entityLabel,
  onScheduled,
}: SchedulePublishDialogProps) {
  const { runStepUp } = useStepUp()
  const initialValue = currentScheduledAt ? new Date(currentScheduledAt) : null

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pendingRef = useRef(false)
  function setPending(value: boolean) { pendingRef.current = value; setBusy(value) }
  function requestClose() { if (!pendingRef.current) onClose() }

  const isAlreadyScheduled = currentScheduledAt !== null

  async function handleConfirm(next: Date) {
    if (pendingRef.current) return
    if (next.getTime() <= Date.now()) {
      setError('Scheduled time must be in the future.')
      return
    }
    await schedulePublish(rowId, next, setPending, setError, onScheduled, onClose, localeId, runStepUp)
  }

  async function handleCancelSchedule() {
    if (pendingRef.current) return
    await cancelSchedule(rowId, setPending, setError, onScheduled, onClose, localeId, runStepUp)
  }

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      closeOnEscape={!busy}
      closeOnBackdrop={!busy}
      hideCloseButton={busy}
      title={isAlreadyScheduled ? `Reschedule this ${entityLabel}` : `Schedule this ${entityLabel}`}
      eyebrow="Publish later"
      size="lg"
      // The picker has its own internal Cancel / Confirm buttons + an
      // optional "Cancel schedule" action for already-scheduled rows.
      // We don't render a separate Dialog footer to avoid two button
      // rows competing for attention.
    >
      <p className={styles.description}>This schedules the current draft in the selected language. Later edits remain drafts. An existing published version stays online until the scheduled version replaces it.</p>
      <DateTimePicker
        key={`${rowId}:${localeId ?? 'default'}:${currentScheduledAt ?? 'new'}`}
        value={initialValue}
        onCancel={requestClose}
        disabled={busy}
        busy={busy}
        onConfirm={handleConfirm}
        minDate={new Date()}
        ariaLabel={`Schedule when to publish this ${entityLabel}`}
      />
      {isAlreadyScheduled && (
        <div className={styles.cancelRow}>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={handleCancelSchedule}
          >
            Cancel current schedule
          </Button>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className={styles.error}
        >
          {error}
        </p>
      )}
    </Dialog>
  )
}
