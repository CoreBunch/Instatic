/**
 * Account → Active devices tab.
 *
 * Lists every live session the current user has across browsers and devices,
 * pinning the *current* one to the top with a "This device" badge. Each
 * other row exposes a "Sign out" action that calls
 * `DELETE /admin/api/cms/auth/sessions/:id`. A "Sign out everywhere else"
 * action in the section header revokes every non-current session in one go.
 *
 * Mutable live state — this is the "kick a device out" surface. Past sign-in
 * activity (including failures and lockouts) lives in the Sign-in history
 * tab and is intentionally append-only there.
 *
 * The current session's row is intentionally non-revocable from this UI —
 * users should use the toolbar avatar's "Sign out" item to drop the cookie
 * along with the row. Calling `DELETE` against the current session id would
 * succeed on the server (well, it would 400 — see `auth.ts`) but leaves the
 * cookie around, so we don't even surface the affordance.
 *
 * Step-up auth (C.3) is intentionally not gating these actions yet. When it
 * lands, the call paths in this file will route through the step-up dialog
 * if the current session has no fresh re-auth window.
 */
import { useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Button } from '@ui/components/Button'
import { SkeletonRows } from '@ui/components/Skeleton'
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from '@ui/components/DataTable'
import {
  listCmsSessions,
  logoutAllOtherCmsSessions,
  revokeCmsSession,
  type CmsSession,
} from '@core/persistence'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import styles from '../AccountPage.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'
import { formatDateTime } from '@admin/lib/formatDateTime'

function formatLastSeen(value: string): string {
  const ms = Date.now() - new Date(value).getTime()
  if (Number.isNaN(ms) || ms < 0) return formatDateTime(value)
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return formatDateTime(value)
}

async function revokeSessionHelper(
  session: CmsSession,
  runStepUp: <T>(fn: () => Promise<T>) => Promise<T>,
  setBusy: (v: string | null) => void,
  setActionError: (v: string | null) => void,
  setStatus: (v: string | null) => void,
  refresh: () => void,
): Promise<void> {
  try {
    await runStepUp(() => revokeCmsSession(session.id))
    setStatus(`Signed out ${session.deviceLabel || 'device'}.`)
    refresh()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) return
    setActionError(getErrorMessage(err, 'Could not sign out device'))
  } finally {
    setBusy(null)
  }
}

async function revokeAllOthersHelper(
  runStepUp: <T>(fn: () => Promise<T>) => Promise<T>,
  setBusy: (v: string | null) => void,
  setActionError: (v: string | null) => void,
  setStatus: (v: string | null) => void,
  refresh: () => void,
): Promise<void> {
  try {
    const revokedCount = await runStepUp(() => logoutAllOtherCmsSessions())
    setStatus(
      revokedCount === 0
        ? 'No other devices were signed in.'
        : `Signed out ${revokedCount} other ${revokedCount === 1 ? 'device' : 'devices'}.`,
    )
    refresh()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) return
    setActionError(getErrorMessage(err, 'Could not sign out other devices'))
  } finally {
    setBusy(null)
  }
}

export function SessionsTab() {
  const { runStepUp } = useStepUp()
  const {
    data,
    loading,
    error: loadError,
    refresh,
  } = useAsyncResource(() => listCmsSessions(), [], { fallbackError: 'Could not load sessions' })
  const sessions: CmsSession[] = data ?? []
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  // Errors from revoke actions live alongside the load error from the
  // resource; the view shows whichever is present.
  const [actionError, setActionError] = useState<string | null>(null)
  const error = loadError ?? actionError

  async function handleRevoke(session: CmsSession): Promise<void> {
    if (busy) return
    setBusy(session.id)
    setActionError(null)
    setStatus(null)
    // The user cancelling the step-up dialog is a silent dismiss — handled inside the helper.
    await revokeSessionHelper(session, runStepUp, setBusy, setActionError, setStatus, refresh)
  }

  async function handleRevokeAllOthers(): Promise<void> {
    if (busy) return
    setBusy('all')
    setActionError(null)
    setStatus(null)
    await revokeAllOthersHelper(runStepUp, setBusy, setActionError, setStatus, refresh)
  }

  const otherCount = sessions.filter((s) => !s.isCurrent).length

  return (
    <section className={styles.section} aria-labelledby="account-sessions-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="account-sessions-title">Active devices</h2>
          <p>Devices currently signed in to your account. Sign any out individually or all at once. For a record of past sign-in attempts (including failures), see Sign-in history.</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy !== null || otherCount === 0}
          onClick={() => void handleRevokeAllOthers()}
          data-testid="account-sessions-sign-out-others"
        >
          <span>{busy === 'all' ? 'Signing out…' : 'Sign out everywhere else'}</span>
        </Button>
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {status && <p className={styles.cardStatus} role="status">{status}</p>}

      {loading ? (
        <SkeletonRows count={4} rowHeight={36} ariaLabel="Loading sessions" />
      ) : sessions.length === 0 ? (
        // The current session is always present, so this branch is only
        // reached on transient empty responses (e.g. the list raced with a
        // global revoke). Render an honest empty state rather than a fake
        // "this device" placeholder.
        <p className={styles.emptyState}>No active sessions.</p>
      ) : (
        <DataTable aria-label="Active sessions" density="compact">
          <DataTableHead>
            <DataTableRow>
              <DataTableHeader scope="col">Device</DataTableHeader>
              <DataTableHeader scope="col">IP</DataTableHeader>
              <DataTableHeader scope="col">Last active</DataTableHeader>
              <DataTableHeader scope="col" className={styles.actionsHeader}>Actions</DataTableHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {sessions.map((session) => {
              const labelText = session.deviceLabel || 'Unknown device'
              return (
                <DataTableRow key={session.id} aria-label={`Session ${labelText}`}>
                  <DataTableCell>
                    <div className={styles.deviceLabel}>
                      <strong>{labelText}</strong>
                      <span>Signed in {formatDateTime(session.createdAt)}</span>
                    </div>
                  </DataTableCell>
                  <DataTableCell>
                    <span className={styles.secondaryText}>{session.ipAddress ?? 'unknown'}</span>
                  </DataTableCell>
                  <DataTableCell>
                    <span className={styles.secondaryText}>
                      {session.isCurrent ? 'This device' : formatLastSeen(session.lastSeenAt)}
                    </span>
                  </DataTableCell>
                  <DataTableCell className={styles.actionsCell}>
                    {session.isCurrent ? (
                      <span className={styles.badgeMuted}>Current</span>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={busy !== null}
                        onClick={() => void handleRevoke(session)}
                        data-testid={`account-sessions-sign-out-${session.id}`}
                      >
                        <span>{busy === session.id ? 'Signing out…' : 'Sign out'}</span>
                      </Button>
                    )}
                  </DataTableCell>
                </DataTableRow>
              )
            })}
          </DataTableBody>
        </DataTable>
      )}
    </section>
  )
}
