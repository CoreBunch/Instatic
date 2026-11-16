/** Activity: the delivery log, newest first, with 30-day totals. */
import { useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import ws from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'
import { Button } from '@ui/components/Button'
import { RangeTabs } from '@ui/components/RangeTabs'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import type { MailActivityEntry, MailActivityStatus } from '@core/mail'
import { getCmsMailActivity } from '@core/persistence'
import styles from '../EmailPage.module.css'

type Filter = 'all' | MailActivityStatus

const FILTER_OPTIONS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
  { value: 'captured', label: 'Captured' },
]

const STATUS_LABEL: Record<MailActivityStatus, string> = { sent: 'Sent', failed: 'Failed', captured: 'Captured' }

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function ActivityTab() {
  const [filter, setFilter] = useState<Filter>('all')
  const { data, loading, error, refresh } = useAsyncResource(
    (signal) => getCmsMailActivity(filter === 'all' ? null : filter, signal),
    [filter],
    { fallbackError: 'Could not load the activity.' },
  )

  return (
    <section className={ws.section} aria-labelledby="email-activity-heading">
      <div className={ws.sectionHeader}>
        <div>
          <h2 id="email-activity-heading">Activity</h2>
          <p>Every email the site tried to send: who it went to, through which connector, and what happened.</p>
        </div>
        <div className={ws.auditHeaderActions}>
          <RangeTabs<Filter> value={filter} options={FILTER_OPTIONS} onChange={setFilter} ariaLabel="Filter by status" />
          <Button type="button" variant="ghost" size="sm" onClick={refresh} tooltip="Refresh" aria-label="Refresh activity" iconOnly>
            <ReloadIcon size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>

      {error && <p role="alert" className={ws.errorAlert}>{error}</p>}
      {loading && !data && <div className={ws.emptyState}>Loading…</div>}

      {data && (
        <>
          <div className={ws.auditTotalsRow}>
            <Total label="Sent" value={data.totals.sent} hint="last 30 days" />
            <Total label="Failed" value={data.totals.failed} hint="last 30 days" />
            <Total label="Captured" value={data.totals.captured} hint="development only" />
          </div>

          <div className={ws.auditPanel}>
            <table className={ws.auditTable} aria-label="Email activity">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Subject</th>
                  <th scope="col">To</th>
                  <th scope="col">Connector</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.length === 0 ? (
                  <tr><td colSpan={5} className={ws.auditEmptyRow}>No email here yet.</td></tr>
                ) : (
                  data.entries.map((entry) => <ActivityRow key={entry.id} entry={entry} />)
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function Total({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className={ws.auditTotalCard}>
      <span className={ws.auditTotalLabel}>{label}</span>
      <span className={ws.auditTotalValue}>{value.toLocaleString()}</span>
      <span className={ws.auditTotalHint}>{hint}</span>
    </div>
  )
}

function ActivityRow({ entry }: { entry: MailActivityEntry }) {
  return (
    <>
      <tr>
        <td><span className={styles.status} data-status={entry.status}>{STATUS_LABEL[entry.status]}</span></td>
        <td>
          {entry.subject}
          <span className={styles.kind}>{entry.kind}</span>
        </td>
        <td>{entry.to}</td>
        <td>{entry.connectorLabel ?? (entry.status === 'captured' ? 'Not sent' : 'Unknown')}</td>
        <td><time dateTime={entry.createdAt}>{formatWhen(entry.createdAt)}</time></td>
      </tr>
      {(entry.error || entry.body) && (
        <tr>
          <td />
          <td colSpan={4} className={styles.detailCell}>
            {entry.error && <p className={styles.rowError}>{entry.error}</p>}
            {entry.body && (
              <details className={styles.rowBody}>
                <summary>Read the message</summary>
                <pre>{entry.body}</pre>
              </details>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
