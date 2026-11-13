import { useEffect } from 'react'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useUpdates } from '@admin/updates/useUpdates'
import { Button } from '@ui/components/Button'
import { INSTATIC_RELEASES_URL } from '@core/updates'
import styles from './UpdatesPage.module.css'

const labels = {
  'update-available': 'A new Instatic release is available',
  current: 'Running version matches the latest stable release',
  ahead: 'Running version is ahead of the latest stable release',
  unknown: 'Running version could not be determined',
}

export function UpdatesPage() {
  const { status, details, busy, error, store } = useUpdates()
  useEffect(() => { void store?.loadDetails() }, [store, status?.checkedAt])
  return (
    <AdminPageLayout workspace="updates" title="Updates" description="Official Instatic releases and changelog."
      actions={<Button variant="secondary" disabled={busy || !store} onClick={() => { void store?.refresh() }}>Check now</Button>}>
      <section className={styles.panel} aria-label="Instatic release status" aria-busy={busy}>
        <h2>{busy && !status ? 'Checking GitHub…' : error || status?.stale ? 'Release check needs attention' : status ? labels[status.comparison] : 'Release status unavailable'}</h2>
        <dl className={styles.versions}>
          <div><dt>Running version</dt><dd>{status?.build.version ?? 'Unknown'}</dd></div>
          <div><dt>Latest stable release{status?.stale ? ' (last known)' : ''}</dt><dd>{status?.latest?.version ?? 'Unknown'}</dd></div>
        </dl>
        {status && <p className={styles.muted}>Build metadata: {status.build.source === 'artifact' ? 'compiled artifact' : status.build.source === 'environment' ? 'deployment environment' : 'package manifest (source build)'}. This identifies the declared version; it does not attest that a custom build is an official release.</p>}
        {status?.build.revision && <p className={styles.muted}>Revision: <code>{status.build.revision}</code></p>}
        {(error || status?.error) && <p className={styles.muted}>{error ?? status?.error}</p>}
        <p className={styles.muted}>Last successful GitHub check: {status?.checkedAt ? new Date(status.checkedAt).toLocaleString() : 'Never'}</p>
        <a href={status?.latest?.url ?? INSTATIC_RELEASES_URL} target="_blank" rel="noopener noreferrer">{status?.latest ? `View ${status.latest.version} release notes & changelog` : 'View official releases'} ↗</a>
        {details?.releaseNotes && <details className={styles.notes}><summary>Release notes</summary><pre>{details.releaseNotes}</pre></details>}
        <p className={styles.muted}>GitHub results are cached for six hours in this server process. Navigation and tab focus reuse the current result. Check now requests a refresh, limited to once per minute; failed requests wait at least five minutes before retrying. Restarting the server clears its cache.</p>
        <p className={styles.muted}>To update, back up your installation and redeploy the desired release. This page does not install software or check npm dependencies. Release availability is not a vulnerability assessment.</p>
      </section>
    </AdminPageLayout>
  )
}
