/**
 * Account → Sign-in history tab.
 *
 * Shows the user's recent login activity from `login_attempts` — successes,
 * failures, lockouts, and rate-limit hits, both `user_id`-matched rows and
 * pre-lookup attempts that mention the user's email.
 *
 * Append-only audit feed — distinct from the Active devices tab, which is a
 * live mutable list of session cookies. A failed attempt that never produced
 * a session still shows up here; a successful login from a device the user
 * later signed out still shows up here. The chip in the header section
 * surfaces a quick "N failed attempts in last 24h" forensic count so the
 * tab is visibly different from Active devices at a glance even when both
 * happen to contain a single row.
 *
 * The "suspicious activity" banner surfaces whenever there's a `locked` or
 * `rate_limited` event in the last 24 h — a low-cost nudge for the user to
 * change their password (when that flow ships in C.4).
 */
import { useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { formatDateTime } from '@admin/lib/formatDateTime'
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from '@ui/components/DataTable'
import { SkeletonRows } from '@ui/components/Skeleton'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import {
  listCmsLoginActivity,
  type CmsLoginActivityEvent,
  type CmsLoginActivityResult,
} from '@core/persistence'
import styles from '../AccountPage.module.css'

const LOOKBACK_24H_MS = 24 * 60 * 60 * 1000

const RESULT_LABELS: Record<CmsLoginActivityResult, string> = {
  success: 'Success',
  bad_password: 'Wrong password',
  no_user: 'Unknown user',
  account_disabled: 'Account suspended',
  locked: 'Account locked',
  rate_limited: 'Rate-limited',
  mfa_failed: 'MFA failed',
}

function resultClass(result: CmsLoginActivityResult): string {
  switch (result) {
    case 'success':
      return styles.activityResultSuccess
    case 'locked':
    case 'rate_limited':
      return styles.activityResultLocked
    default:
      return styles.activityResultBad
  }
}

function isFailure(result: CmsLoginActivityResult): boolean {
  return result !== 'success'
}

function isWithin24h(event: CmsLoginActivityEvent, now: number): boolean {
  const ts = Date.parse(event.attemptedAt)
  if (Number.isNaN(ts)) return false
  return now - ts < LOOKBACK_24H_MS
}

function isRecentSuspicious(event: CmsLoginActivityEvent, now: number): boolean {
  if (event.result !== 'locked' && event.result !== 'rate_limited') return false
  return isWithin24h(event, now)
}

export function ActivityTab() {
  const { data, loading, error } = useAsyncResource(() => listCmsLoginActivity(), [], {
    fallbackError: 'Could not load activity',
  })
  const events: CmsLoginActivityEvent[] = data ?? []
  // `now` is captured once at mount so the suspicious-banner threshold is
  // stable across renders. Calling `Date.now()` during render trips the
  // React 19 impure-call rule; the user-visible timestamps inside individual
  // rows are computed at format time, not against this anchor.
  const [mountedAt] = useState<number>(() => Date.now())

  const showSuspiciousBanner = events.some((event) => isRecentSuspicious(event, mountedAt))

  const failedIn24h = events.filter(
    (event) => isFailure(event.result) && isWithin24h(event, mountedAt),
  ).length

  return (
    <section className={styles.section} aria-labelledby="account-activity-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="account-activity-title">Sign-in history</h2>
          <p>Recent sign-in attempts on your account, including failures and lockouts. To revoke a current session, use Active devices.</p>
        </div>
        {failedIn24h > 0 && (
          <span
            className={`${styles.badge} ${styles.activityFailureBadge}`}
            data-testid="account-activity-failed-count"
          >
            {failedIn24h} failed in last 24h
          </span>
        )}
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}

      {showSuspiciousBanner && (
        <div className={styles.suspiciousBanner} role="status" data-testid="account-activity-suspicious">
          <CircleAlertSolidIcon size={14} aria-hidden="true" />
          <span>
            Suspicious activity in the last 24 hours. Review the entries below — if any are unfamiliar,
            consider changing your password once that lands.
          </span>
        </div>
      )}

      {loading ? (
        <SkeletonRows count={6} rowHeight={32} ariaLabel="Loading activity" />
      ) : events.length === 0 ? (
        <p className={styles.emptyState}>No login activity yet.</p>
      ) : (
        <DataTable aria-label="Login activity" density="compact">
          <DataTableHead>
            <DataTableRow>
              <DataTableHeader scope="col">When</DataTableHeader>
              <DataTableHeader scope="col">Device</DataTableHeader>
              <DataTableHeader scope="col">IP</DataTableHeader>
              <DataTableHeader scope="col">Outcome</DataTableHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {events.map((event) => (
              <DataTableRow key={event.id} aria-label={`Activity ${event.result}`}>
                <DataTableCell>
                  <span className={styles.secondaryText}>{formatDateTime(event.attemptedAt)}</span>
                </DataTableCell>
                <DataTableCell>
                  <span className={styles.secondaryText}>{event.deviceLabel || 'Unknown device'}</span>
                </DataTableCell>
                <DataTableCell>
                  <span className={styles.secondaryText}>{event.ipAddress ?? 'unknown'}</span>
                </DataTableCell>
                <DataTableCell>
                  <span className={styles.activityRow}>
                    <span className={`${styles.activityResult} ${resultClass(event.result)}`}>
                      {RESULT_LABELS[event.result]}
                    </span>
                  </span>
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </section>
  )
}
