import { useEffect, type ReactNode } from 'react'
import { ServiceActivitySchema } from '@core/serviceAccounts'
import type { CoreCapability } from '@core/capabilities'
import { apiRequest } from '@core/http'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useAdminUi } from '@admin/state/adminUi'
import { capabilityLabel } from '@admin/shared/CapabilityPicker'
import { Button } from '@ui/components/Button'
import { Alert } from '@ui/components/Alert'
import { Heading } from '@ui/components/Heading'
import { Text } from '@ui/components/Text'
import { cn } from '@ui/cn'
import { CliIdentityIcon } from './CliIdentityIcon'
import layout from '@admin/shared/SettingsWorkspace/WorkspaceSection.module.css'
import directory from '@admin/shared/Directory/Directory.module.css'
import styles from './ServiceAccounts.module.css'

const formatCliDate = (date: string) => new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
type Member = { label: string; responsibility?: string; connected?: boolean; capabilities: CoreCapability[] }

function Activity({ id, live }: { id?: string; live: boolean }) {
  const { data, error, refresh } = useAsyncResource(signal => id
    ? apiRequest('/admin/api/cms/service-accounts/' + id + '/activity', { schema: ServiceActivitySchema, signal })
    : Promise.resolve({ events: [] }), [id, live], { fallbackError: 'Could not load activity' })
  useEffect(() => {
    if (!id || !live) return
    const timer = window.setInterval(() => { if (!document.hidden) refresh() }, 4000)
    return () => window.clearInterval(timer)
  }, [id, live, refresh])
  return <section className={cn(layout.detailCard, styles.stack)}>
    <Heading level={3}>Activity</Heading>
    {error && <Alert tone="danger">{error}</Alert>}
    {data?.events.length ? <ol className={styles.timeline}>{data.events.map(event => <li key={event.id}>
      <div><Text variant="strong">{event.title}</Text>
        <Text variant="muted" size="sm">{[event.agent, event.scope, event.status && event.status >= 400 ? 'HTTP ' + event.status : null].filter(Boolean).join(' · ')}</Text></div>
      <time dateTime={event.at}>{formatCliDate(event.at)}</time>
    </li>)}</ol> : <Text variant="muted">{data ? 'Activity appears here when a connection is created or used.' : 'Loading activity…'}</Text>}
  </section>
}

export function ConnectionDetail({ title, type, status, scope, expiry, agents, task, actions, guidance, activityId, live, onBack, history }: {
  title: string; type: string; status: string; scope: string; expiry?: string; agents: Member[]; task?: string
  actions: ReactNode; guidance?: ReactNode; activityId?: string; live: boolean; onBack: () => void; history?: ReactNode
}) {
  const site = useAdminUi(s => s.siteName)
  return <article aria-label="Connection details" className={styles.stack}>
    <nav className={styles.actions} aria-label="CLI navigation"><Button variant="ghost" size="xs" onClick={onBack}>CLI connections</Button><Text variant="muted" size="sm">/ {type}</Text></nav>
    <header className={layout.sectionHeader}><div><Heading level={2}>{title}</Heading><Text variant="muted">{status} · {agents.length} {agents.length === 1 ? 'agent' : 'agents'}</Text></div>
      <div className={styles.actions}>{actions}</div></header>
    {guidance}
    {history}
    <div className={styles.detailsLayout}><Activity key={activityId ?? 'unstarted'} id={activityId} live={live} />
      <aside className={styles.stack}><section className={cn(layout.detailCard, styles.stack)}><Heading level={3}>Access</Heading><dl className={directory.facts}>
        <div><dt>Site</dt><dd>{site ?? location.host}</dd></div><div><dt>Scope</dt><dd>{scope}</dd></div>
        <div><dt>Expires</dt><dd>{expiry ? <time dateTime={expiry}>{formatCliDate(expiry)}</time> : 'Set when starting a run'}</dd></div>
      </dl></section>
      <section className={cn(layout.detailCard, styles.group)}><Heading level={3}>Agents</Heading>{agents.map(a => <details key={a.label} className={styles.member}>
        <summary><CliIdentityIcon agent={a.label}/><strong>{a.label}</strong></summary>
        {a.responsibility && <Text>{a.responsibility}</Text>}
        <Text variant="muted" size="sm">Permissions</Text><Text>{a.capabilities.map(capabilityLabel).join(', ')}</Text>
      </details>)}</section>
      {task && <section className={cn(layout.detailCard, styles.group)}><Heading level={3}>Task</Heading><Text>{task}</Text></section>}
      </aside>
    </div>
  </article>
}
