/**
 * Activity: what happened to every email the site tried to send.
 *
 * Top to bottom: the period's numbers and its volume chart, then the filters,
 * then the log itself as a list with the selected email's details beside it.
 * The numbers describe the whole period; the filters only narrow the list.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import ws from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { RangeTabs } from '@ui/components/RangeTabs'
import { SearchBar } from '@ui/components/SearchBar'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import type {
  MailActivityEntry,
  MailActivityPeriod,
  MailActivityResponse,
  MailActivityStatus,
} from '@core/mail'
import { getCmsMailActivity, type CmsMailActivityQuery } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { formatRelativeTimeAgo } from '@core/utils/relativeTime'
import ld from '@admin/shared/ListDetail/ListDetail.module.css'
import styles from './ActivityTab.module.css'
import { MailSolidIcon } from 'pixel-art-icons/icons/mail-solid'

type StatusFilter = 'all' | MailActivityStatus

const PERIOD_OPTIONS: ReadonlyArray<{ value: MailActivityPeriod; label: string }> = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All' },
]

const PERIOD_PHRASE: Record<MailActivityPeriod, string> = {
  '24h': 'in the last 24 hours',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
  all: 'in the log',
}

const STATUS_LABEL: Record<MailActivityStatus, string> = {
  queued: 'Waiting to be sent',
  sent: 'Delivered to provider',
  failed: 'Failed',
  captured: 'Captured, not sent',
}

const STATUS_TONE: Record<Exclude<MailActivityStatus, 'queued'>, 'success' | 'danger' | 'warning'> = {
  sent: 'success',
  failed: 'danger',
  captured: 'warning',
}

type Progress = Pick<MailActivityEntry, 'status' | 'attempts' | 'error'>

/** A waiting email is neutral until something has gone wrong; then it is a warning. */
function toneOf(entry: Progress): 'success' | 'danger' | 'warning' | undefined {
  if (entry.status === 'queued') return entry.error !== null ? 'warning' : undefined
  return STATUS_TONE[entry.status]
}

/**
 * A waiting email with an error and a counted attempt is being retried. With
 * an error and no attempt counted, it is held: the connector refused the
 * account, which is not the email's failure.
 */
function statusLabel(entry: Progress): string {
  if (entry.status !== 'queued' || entry.error === null) return STATUS_LABEL[entry.status]
  return entry.attempts > 0 ? 'Retrying' : 'Held'
}

const STATUS_SHORT: Record<MailActivityStatus, string> = {
  queued: 'Waiting',
  sent: 'Sent',
  failed: 'Failed',
  captured: 'Captured',
}

const ALL = ''
const SEARCH_DELAY_MS = 250

function formatFull(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'medium' })
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** A chart bucket's start as a short label: an hour for `24h`, a day otherwise. */
function formatBucket(start: string, period: MailActivityPeriod): string {
  if (period === '24h') return new Date(start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  // A calendar day (`YYYY-MM-DD`): read it at noon so no zone shifts it to its neighbour.
  return new Date(`${start}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`
}

export function ActivityTab({
  capturing,
  onOpenConnectors,
  onOpenTemplate,
}: {
  /** The site is capturing mail instead of sending it (a development server). */
  capturing: boolean
  onOpenConnectors: () => void
  onOpenTemplate: (key: string) => void
}) {
  const [period, setPeriod] = useState<MailActivityPeriod>('30d')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [kind, setKind] = useState(ALL)
  const [connector, setConnector] = useState(ALL)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Pages read with "Show more", kept only while the filters they were read for still apply.
  const [more, setMore] = useState<{ key: string; entries: MailActivityEntry[]; nextCursor: string | null } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const query: CmsMailActivityQuery = {
    period,
    status: status === 'all' ? null : status,
    kind: kind === ALL ? null : kind,
    connector: connector === ALL ? null : connector,
    search,
  }
  const queryKey = JSON.stringify(query)
  const { data, loading, error, refresh } = useAsyncResource(
    (signal) => getCmsMailActivity(query, signal),
    [queryKey],
    { fallbackError: 'Could not load the activity.' },
  )

  const extra = more?.key === queryKey ? more : null
  const entries = data ? [...data.entries, ...(extra?.entries ?? [])] : []
  const nextCursor = extra ? extra.nextCursor : (data?.nextCursor ?? null)
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null
  const filtered = status !== 'all' || kind !== ALL || connector !== ALL || search.trim() !== ''

  function clearFilters() {
    setStatus('all')
    setKind(ALL)
    setConnector(ALL)
    setSearchInput('')
    setSearch('')
  }

  function reload() {
    setMore(null)
    refresh()
  }

  async function showMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const next = await getCmsMailActivity({ ...query, before: nextCursor })
      setMore({ key: queryKey, entries: [...(extra?.entries ?? []), ...next.entries], nextCursor: next.nextCursor })
    } catch (err) {
      console.error('[ActivityTab] loading more activity failed:', err)
      pushToast({ kind: 'error', title: 'Could not load more emails', body: getErrorMessage(err, 'Unknown activity error') })
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section className={ws.section} aria-labelledby="email-activity-heading">
      <div className={ws.sectionHeader}>
        <div>
          <h2 id="email-activity-heading">Activity</h2>
          <p>Every email the site tried to send: who it went to, how it left, and what happened.</p>
        </div>
        <div>
          <div className={styles.headerActions}>
            <RangeTabs<MailActivityPeriod> value={period} options={PERIOD_OPTIONS} onChange={setPeriod} ariaLabel="Period" />
            <Button type="button" variant="ghost" size="sm" onClick={reload} tooltip="Refresh" aria-label="Refresh activity" iconOnly>
              <ReloadIcon size={14} aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>

      {error && <p role="alert" className={ws.errorAlert}>{error}</p>}
      {loading && !data && <div className={ws.emptyState}>Loading…</div>}

      {data && (
        <>
          <Summary data={data} period={period} capturing={capturing} onShowFailed={() => setStatus('failed')} onShowWaiting={() => setStatus('queued')} />

          <div className={styles.filters}>
            <SearchBar
              className={styles.search}
              value={searchInput}
              onValueChange={setSearchInput}
              onClear={() => setSearchInput('')}
              placeholder="Search recipient or subject"
              aria-label="Search recipient or subject"
            />
            <RangeTabs<StatusFilter>
              value={status}
              options={[
                { value: 'all', label: 'All' },
                ...(data.totals.queued > 0 || status === 'queued'
                  ? [{ value: 'queued' as const, label: `Waiting ${data.totals.queued.toLocaleString()}` }]
                  : []),
                { value: 'sent', label: `Sent ${data.totals.sent.toLocaleString()}` },
                { value: 'failed', label: `Failed ${data.totals.failed.toLocaleString()}` },
                ...(data.totals.captured > 0 || status === 'captured'
                  ? [{ value: 'captured' as const, label: `Captured ${data.totals.captured.toLocaleString()}` }]
                  : []),
              ]}
              onChange={setStatus}
              ariaLabel="Filter by status"
            />
            <div className={styles.filterSelect}>
              <Select
                aria-label="Filter by template"
                fieldSize="sm"
                value={kind}
                options={[
                  { value: ALL, label: 'All templates' },
                  ...data.kinds.map((facet) => ({ value: facet.value, label: `${facet.label} (${facet.count})`, textValue: facet.label })),
                ]}
                onChange={(event) => setKind(event.currentTarget.value)}
              />
            </div>
            {data.connectors.length > 0 && (
              <div className={styles.filterSelect}>
                <Select
                  aria-label="Filter by connector"
                  fieldSize="sm"
                  value={connector}
                  options={[
                    { value: ALL, label: 'All connectors' },
                    ...data.connectors.map((facet) => ({ value: facet.value, label: `${facet.label} (${facet.count})`, textValue: facet.label })),
                  ]}
                  onChange={(event) => setConnector(event.currentTarget.value)}
                />
              </div>
            )}
          </div>

          {entries.length === 0 ? (
            <EmptyState
              variant="centered"
              icon={<MailSolidIcon size={28} />}
              title={filtered ? 'No email matches these filters' : `No email ${PERIOD_PHRASE[period]}`}
              description={
                filtered
                  ? 'Try another search, or clear the filters to see everything in this period.'
                  : 'Emails appear here the moment the site tries to send them.'
              }
              action={filtered ? <Button type="button" variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
            />
          ) : (
            <div className={ld.split}>
              <div className={ld.list}>
                <div className={ld.listHeader}>
                  <span>
                    {filtered
                      ? `${plural(data.matching, 'email')} match`
                      : `${plural(data.matching, 'email')} ${PERIOD_PHRASE[period]}`}
                  </span>
                  {filtered && (
                    <Button type="button" variant="ghost" size="xs" onClick={clearFilters}>Clear filters</Button>
                  )}
                </div>
                <ul className={ld.rows} aria-label="Email activity">
                  {entries.map((entry) => {
                    const active = selected?.id === entry.id
                    return (
                      <li key={entry.id}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="md"
                          fullWidth
                          align="start"
                          active={active}
                          aria-current={active ? 'true' : undefined}
                          className={ld.row}
                          onClick={() => setSelectedId(entry.id)}
                        >
                          <span className={ld.dot} data-tone={toneOf(entry)} aria-hidden="true" />
                          <span className={ld.rowMain}>
                            <span className={ld.rowSubject}>{entry.subject}</span>
                            <span className={ld.rowMeta}>
                              <span className={styles.srOnly}>{STATUS_SHORT[entry.status]}. </span>
                              {entry.to} · {entry.kindLabel}
                            </span>
                          </span>
                          <time className={ld.rowTime} dateTime={entry.createdAt} title={formatFull(entry.createdAt)}>
                            {formatRelativeTimeAgo(Date.parse(entry.createdAt))}
                          </time>
                        </Button>
                      </li>
                    )
                  })}
                </ul>
                <div className={ld.listFooter}>
                  {nextCursor ? (
                    <Button type="button" variant="secondary" size="sm" onClick={showMore} busy={loadingMore}>
                      Show more
                    </Button>
                  ) : (
                    <span>
                      End of the list. The log keeps the newest {data.retention.toLocaleString()} emails.
                    </span>
                  )}
                </div>
              </div>

              {selected && (
                <Detail entry={selected} onOpenConnectors={onOpenConnectors} onOpenTemplate={onOpenTemplate} />
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function Summary({
  data,
  period,
  capturing,
  onShowFailed,
  onShowWaiting,
}: {
  data: MailActivityResponse
  period: MailActivityPeriod
  capturing: boolean
  onShowFailed: () => void
  onShowWaiting: () => void
}) {
  const { queued, sent, failed, captured } = data.totals
  const attempts = sent + failed
  const rate = attempts > 0 ? `${((sent / attempts) * 100).toFixed(attempts >= 1000 ? 1 : 0)}%` : null
  const peak = Math.max(
    1,
    ...data.buckets.map((bucket) => bucket.queued + bucket.sent + bucket.failed + bucket.captured),
  )
  const first = data.buckets[0]
  const last = data.buckets[data.buckets.length - 1]

  return (
    <div className={styles.summary} data-crowded={queued > 0 && (capturing || captured > 0) ? 'true' : undefined}>
      <div className={styles.tile}>
        <span className={styles.tileLabel}>Sent</span>
        <span className={styles.tileValue}>{sent.toLocaleString()}</span>
        <span className={styles.tileHint}>
          {rate ? `${rate} of ${plural(attempts, 'attempt')} left the site` : 'Nothing sent in this period'}
        </span>
      </div>

      {queued > 0 && (
        <div className={styles.tile} data-tone={data.waitingError ? 'warning' : undefined}>
          <span className={styles.tileLabel}>Waiting</span>
          <span className={styles.tileValue}>{queued.toLocaleString()}</span>
          <span className={styles.tileHint}>
            {data.waitingError ?? 'Queued, and sent as soon as the connector is free'}{' '}
            {data.waitingError && (
              <Button type="button" variant="ghost" size="xs" className={styles.inlineAction} onClick={onShowWaiting}>
                Show waiting
              </Button>
            )}
          </span>
        </div>
      )}

      <div className={styles.tile} data-tone={failed > 0 ? 'danger' : undefined}>
        <span className={styles.tileLabel}>Failed</span>
        <span className={styles.tileValue}>{failed.toLocaleString()}</span>
        {data.lastFailure ? (
          <span className={styles.tileHint}>
            Last {formatRelativeTimeAgo(Date.parse(data.lastFailure.at))}.{' '}
            <Button type="button" variant="ghost" size="xs" className={styles.inlineAction} onClick={onShowFailed}>
              Show failures
            </Button>
          </span>
        ) : (
          <span className={styles.tileHint}>No failures in this period</span>
        )}
      </div>

      {(capturing || captured > 0) && (
        <div className={styles.tile} data-tone={captured > 0 ? 'warning' : undefined}>
          <span className={styles.tileLabel}>Captured</span>
          <span className={styles.tileValue}>{captured.toLocaleString()}</span>
          <span className={styles.tileHint}>
            {capturing ? 'This is a development server: emails are kept here, not sent' : 'Kept here instead of sent'}
          </span>
        </div>
      )}

      <div className={styles.tile} data-wide="true">
        <span className={styles.tileLabel}>Volume {period === '24h' ? 'by hour' : 'by day'}</span>
        <ol className={styles.chart} aria-label="Emails over the period">
          {data.buckets.map((bucket) => {
            const total = bucket.queued + bucket.sent + bucket.failed + bucket.captured
            const label = `${formatBucket(bucket.start, period)}: ${
              total === 0
                ? 'no email'
                : [
                    bucket.sent > 0 ? `${bucket.sent} sent` : '',
                    bucket.queued > 0 ? `${bucket.queued} waiting` : '',
                    bucket.failed > 0 ? `${bucket.failed} failed` : '',
                    bucket.captured > 0 ? `${bucket.captured} captured` : '',
                  ].filter(Boolean).join(', ')
            }`
            return (
              <li
                key={bucket.start}
                className={styles.column}
                title={label}
                style={{
                  '--queued': bucket.queued / peak,
                  '--sent': bucket.sent / peak,
                  '--failed': bucket.failed / peak,
                  '--captured': bucket.captured / peak,
                } as CSSProperties}
              >
                <span className={styles.srOnly}>{label}</span>
                <span className={styles.segment} data-status="failed" aria-hidden="true" />
                <span className={styles.segment} data-status="captured" aria-hidden="true" />
                <span className={styles.segment} data-status="queued" aria-hidden="true" />
                <span className={styles.segment} data-status="sent" aria-hidden="true" />
              </li>
            )
          })}
        </ol>
        {first && last && (
          <span className={styles.chartAxis} aria-hidden="true">
            <span>{formatBucket(first.start, period)}</span>
            <span>{period === '24h' ? 'Now' : 'Today'}</span>
          </span>
        )}
      </div>
    </div>
  )
}

function Detail({
  entry,
  onOpenConnectors,
  onOpenTemplate,
}: {
  entry: MailActivityEntry
  onOpenConnectors: () => void
  onOpenTemplate: (key: string) => void
}) {
  async function copy(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value)
      pushToast({ kind: 'success', title: `${what} copied` })
    } catch (err) {
      console.error('[ActivityTab] copy failed:', err)
      pushToast({ kind: 'error', title: `Could not copy the ${what.toLowerCase()}`, body: getErrorMessage(err, 'Clipboard unavailable') })
    }
  }

  return (
    <article className={ld.detail} aria-label="Email details">
      <header className={ld.detailHeader}>
        <span className={ld.statusBadge} data-tone={toneOf(entry)}>
          <span className={ld.dot} data-tone={toneOf(entry)} aria-hidden="true" />
          {statusLabel(entry)}
        </span>
        <h3>{entry.subject}</h3>
        <p>
          <time dateTime={entry.createdAt}>{formatFull(entry.createdAt)}</time>
        </p>
      </header>

      {entry.status === 'failed' && (
        <div className={ld.notice} data-tone="danger" role="status">
          <strong>{entry.error ?? 'Delivery failed'}</strong>
          <span>
            {entry.attempts > 1
              ? `Nothing was delivered after ${entry.attempts} attempts, and the site has stopped trying.`
              : 'Nothing was delivered, and the site is not trying again.'}{' '}
            Check the connector, then send a test.
          </span>
          <div>
            <Button type="button" variant="secondary" size="sm" onClick={onOpenConnectors}>Open connectors</Button>
          </div>
        </div>
      )}
      {entry.status === 'queued' && (
        <div className={ld.notice} data-tone={entry.error !== null ? 'warning' : undefined} role="status">
          {entry.error !== null && <strong>{entry.error}</strong>}
          <span>
            {entry.error === null
              ? 'Accepted and waiting for its turn. It is sent as soon as the connector is free.'
              : entry.nextAttemptAt
                ? `Tried ${plural(entry.attempts, 'time')}. The next attempt is due ${formatFull(entry.nextAttemptAt)}. The site keeps trying until the email would be of no use any more.`
                : 'Held while the connector is paused. The site tries one email every two minutes; this one is sent as soon as the connector works again.'}
          </span>
          {entry.error !== null && !entry.nextAttemptAt && (
            <div>
              <Button type="button" variant="secondary" size="sm" onClick={onOpenConnectors}>Open connectors</Button>
            </div>
          )}
        </div>
      )}
      {(entry.status === 'sent' || entry.status === 'captured') && entry.error !== null && (
        <div className={ld.notice} data-tone="warning" role="status">
          <strong>{entry.error}</strong>
          {entry.template && (
            <div>
              <Button type="button" variant="secondary" size="sm" onClick={() => onOpenTemplate(entry.kind)}>Open the template</Button>
            </div>
          )}
        </div>
      )}
      {entry.status === 'sent' && (
        <p className={ld.notice}>
          {entry.connectorLabel ?? 'The connector'} accepted this email. Whether it reached the inbox (bounces, spam
          filtering) is recorded by the provider, not here.
        </p>
      )}
      {entry.status === 'captured' && (
        <p className={ld.notice} data-tone="warning">
          This email never left the server. A development server with no connector and sender keeps emails here so
          you can read them.
        </p>
      )}

      <dl className={ld.facts}>
        <div>
          <dt>To</dt>
          <dd>
            <span className={ld.selectable}>{entry.to}</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => copy(entry.to, 'Address')}>Copy</Button>
          </dd>
        </div>
        <div>
          <dt>Template</dt>
          <dd>
            <span>{entry.kindLabel}</span>
            {entry.template && (
              <Button type="button" variant="ghost" size="xs" onClick={() => onOpenTemplate(entry.kind)}>Open</Button>
            )}
          </dd>
        </div>
        {entry.sentBy !== null && (
          <div>
            <dt>Sent by</dt>
            <dd>{entry.sentBy}</dd>
          </div>
        )}
        <div>
          <dt>Connector</dt>
          <dd>
            {entry.connectorLabel ??
              (entry.status === 'captured' ? 'None (not sent)' : entry.status === 'queued' ? 'Not tried yet' : 'Unknown')}
          </dd>
        </div>
        {entry.attempts > 1 && (
          <div>
            <dt>Attempts</dt>
            <dd>{entry.attempts}</dd>
          </div>
        )}
        {entry.durationMs !== null && (
          <div>
            <dt>{entry.status === 'failed' ? 'Failed after' : 'Hand-over took'}</dt>
            <dd>{formatDuration(entry.durationMs)}</dd>
          </div>
        )}
        {entry.providerMessageId && (
          <div>
            <dt>Provider message ID</dt>
            <dd>
              <code className={ld.selectable}>{entry.providerMessageId}</code>
              <Button type="button" variant="ghost" size="xs" onClick={() => copy(entry.providerMessageId ?? '', 'Message ID')}>Copy</Button>
            </dd>
          </div>
        )}
      </dl>

      {entry.body !== null && (
        <section className={styles.message} aria-label="Message">
          <h4>Message</h4>
          <pre>{entry.body}</pre>
        </section>
      )}
    </article>
  )
}
