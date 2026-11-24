import { useEffect, useState } from 'react'
import { GitBranchSolidIcon } from 'pixel-art-icons/icons/git-branch-solid'
import { apiRequest } from '@core/http'
import { ServiceActivitySchema, type ServiceAccount, type ServiceActivity } from '@core/serviceAccounts'
import { formatRelativeTime } from '@core/utils/relativeTime'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Alert } from '@ui/components/Alert'
import { Button } from '@ui/components/Button'
import { Heading } from '@ui/components/Heading'
import { Text } from '@ui/components/Text'
import directory from '@admin/shared/Directory/Directory.module.css'
import styles from './ServiceAccounts.module.css'

function summarize(events: ServiceActivity[]) {
  const rows: { event: ServiceActivity; count: number }[] = []
  for (const event of events) {
    const last = rows.at(-1)
    if (last && !event.expiresAt && last.event.title === event.title && last.event.scope === event.scope && last.event.status === event.status) {
      last.count++
    } else {
      rows.push({ event, count: 1 })
    }
  }
  return rows.slice(0, 3)
}

export function RecentActivity({ account, refreshStatus }: { account: ServiceAccount; refreshStatus: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const active = !account.revoked && !account.expired
  const { data, error, refresh, loading } = useAsyncResource(signal =>
    apiRequest('/admin/api/cms/service-accounts/' + account.id + '/activity', { schema: ServiceActivitySchema, signal }), [account.id, active])
  useEffect(() => {
    if (account.revoked || loading) return
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        refreshStatus()
        refresh()
      }
    }, 4000)
    return () => window.clearInterval(timer)
  }, [account.revoked, loading, refresh, refreshStatus])
  const events = data?.events ?? []
  const rows = expanded ? events.map(event => ({ event, count: 1 })) : summarize(events)
  const sharedScope = rows[0]?.event.scope
  const showSharedScope = !expanded && sharedScope && rows.every(row => row.event.scope === sharedScope)
  return <section className={directory.section} aria-label="Recent activity">
    <div className={styles.activityHeader}>
      <Heading level={4}>Recent activity</Heading>
      {events.length > rows.length || expanded ? (
        <Button variant="ghost" size="xs" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'View all (' + events.length + ')'}
        </Button>
      ) : null}
    </div>
    {error && <Alert tone="danger">{error}</Alert>}
    {rows.length ? <ol className={styles.activity}>{rows.map(({ event, count }) => {
      const date = new Date(event.at)
      const failed = event.status !== null && event.status >= 400
      return <li key={event.id}>
        <div className={styles.activityTitle}>
          <span>{event.title}</span>
          {count > 1 && <small aria-label={count + ' consecutive operations'}>×{count}</small>}
          {failed && <small className={styles.activityError}>HTTP {event.status}</small>}
        </div>
        <time dateTime={event.at} title={date.toLocaleString()}>{formatRelativeTime(date.getTime())}</time>
        {event.expiresAt && <small className={styles.activityScope}>
          Until {new Date(event.expiresAt).toLocaleString()}
        </small>}
        {event.scope && !showSharedScope && <small className={styles.activityScope}>
          <GitBranchSolidIcon size={12} aria-label="Branch" />{event.scope}
        </small>}
      </li>
    })}</ol> : !error && <Text size="sm" variant="muted">{data ? 'No recent activity.' : 'Loading activity…'}</Text>}
    {showSharedScope && <small className={styles.activityScope}>
      <GitBranchSolidIcon size={12} aria-label="Branch" />{sharedScope}
    </small>}
  </section>
}
