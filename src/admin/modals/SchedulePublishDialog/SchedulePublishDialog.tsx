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
 * inline message + the dialog stays open so the user can retry.
 */
import { useState } from 'react'
import {
  scheduleCmsDataRowPublish,
  cancelCmsDataRowSchedule,
} from '@core/persistence'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { DateTimePicker } from '@ui/components/DateTimePicker'
import { getErrorMessage } from '@core/utils/errorMessage'

interface SchedulePublishDialogProps {
  open: boolean
  onClose: () => void
  rowId: string
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
  onScheduled: () => void
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
  onScheduled: () => void,
  onClose: () => void,
): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    await scheduleCmsDataRowPublish(rowId, next.toISOString())
    onScheduled()
    onClose()
  } catch (err) {
    console.error('[schedule-dialog] Schedule failed:', err)
    const message = getErrorMessage(err, 'Failed to schedule publish')
    setError(message)
  } finally {
    setBusy(false)
  }
}

async function cancelSchedule(
  rowId: string,
  setBusy: (v: boolean) => void,
  setError: (msg: string | null) => void,
  onScheduled: () => void,
  onClose: () => void,
): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    await cancelCmsDataRowSchedule(rowId)
    onScheduled()
    onClose()
  } catch (err) {
    console.error('[schedule-dialog] Cancel schedule failed:', err)
    const message = getErrorMessage(err, 'Failed to cancel schedule')
    setError(message)
  } finally {
    setBusy(false)
  }
}

export function SchedulePublishDialog({
  open,
  onClose,
  rowId,
  currentScheduledAt,
  entityLabel,
  onScheduled,
}: SchedulePublishDialogProps) {
  const initialValue = currentScheduledAt ? new Date(currentScheduledAt) : null

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isAlreadyScheduled = currentScheduledAt !== null

  async function handleConfirm(next: Date) {
    if (next.getTime() <= Date.now()) {
      setError('Scheduled time must be in the future.')
      return
    }
    await schedulePublish(rowId, next, setBusy, setError, onScheduled, onClose)
  }

  async function handleCancelSchedule() {
    await cancelSchedule(rowId, setBusy, setError, onScheduled, onClose)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isAlreadyScheduled ? `Reschedule this ${entityLabel}` : `Schedule this ${entityLabel}`}
      eyebrow="Publish later"
      size="lg"
      // The picker has its own internal Cancel / Confirm buttons + an
      // optional "Cancel schedule" action for already-scheduled rows.
      // We don't render a separate Dialog footer to avoid two button
      // rows competing for attention.
    >
      <DateTimePicker
        value={initialValue}
        onCancel={onClose}
        onConfirm={handleConfirm}
        minDate={new Date()}
        ariaLabel={`Schedule when to publish this ${entityLabel}`}
      />
      {isAlreadyScheduled && (
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
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
          style={{
            marginTop: 8,
            color: 'var(--editor-danger)',
            fontSize: 12,
          }}
        >
          {error}
        </p>
      )}
    </Dialog>
  )
}
