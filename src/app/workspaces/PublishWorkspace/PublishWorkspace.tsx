import { useEffect, useMemo, useState } from 'react'
import { useEditorStore } from '@core/editor-store/store'
import { classifyProjectForPublish } from '@core/publishing/classifyProject'
import type { PublishJob, PublishMode } from '@core/publishing/types'
import { Button } from '@ui/components/Button'
import { Icon } from '@ui/icons/Icon'
import styles from './PublishWorkspace.module.css'

const TERMINAL_STATUSES = new Set(['ready', 'failed'])

export default function PublishWorkspace() {
  const project = useEditorStore((state) => state.project)
  const classification = useMemo(() => project ? classifyProjectForPublish(project) : null, [project])
  const [mode, setMode] = useState<PublishMode>('static')
  const [job, setJob] = useState<PublishJob | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (classification) setMode(classification.mode)
  }, [classification])

  useEffect(() => {
    if (!job || TERMINAL_STATUSES.has(job.status)) return
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/publish/${job.id}`)
      const data = await response.json() as { job?: PublishJob; error?: string }
      if (data.job) setJob(data.job)
      if (data.error) setError(data.error)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [job])

  async function publish() {
    if (!project) return
    setError(null)
    const response = await fetch('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, mode }),
    })
    const data = await response.json() as { job?: PublishJob; error?: string }
    if (!response.ok || data.error) {
      setError(data.error ?? 'Unable to start publish.')
      return
    }
    setJob(data.job ?? null)
  }

  if (!project) {
    return (
      <main className={styles.empty}>
        <Icon name="upload" size={26} aria-hidden="true" />
        <h1>Loading project</h1>
      </main>
    )
  }

  const diagnostics = classification?.diagnostics ?? []
  const isPublishing = Boolean(job && !TERMINAL_STATUSES.has(job.status))

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Publish</h1>
          <p>Deploy this project to managed Vercel and Convex resources.</p>
        </div>
        <Button type="button" variant="primary" size="sm" accentFill onClick={publish} disabled={isPublishing}>
          <Icon name="upload" size={13} aria-hidden="true" />
          {job?.status === 'ready' ? 'Republish' : isPublishing ? 'Publishing' : 'Publish'}
        </Button>
      </header>

      <section className={styles.grid}>
        <div className={styles.panel}>
          <h2>Preflight</h2>
          <div className={styles.modeGrid}>
            <label className={mode === 'static' ? `${styles.modeCard} ${styles.modeCardActive}` : styles.modeCard}>
              <input
                type="radio"
                name="publish-mode"
                value="static"
                checked={mode === 'static'}
                onChange={() => setMode('static')}
                disabled={project.data.tables.length > 0}
              />
              <strong>Static frontend</strong>
              <span>Vite app on Vercel, no Convex backend.</span>
            </label>
            <label className={mode === 'managed-convex' ? `${styles.modeCard} ${styles.modeCardActive}` : styles.modeCard}>
              <input
                type="radio"
                name="publish-mode"
                value="managed-convex"
                checked={mode === 'managed-convex'}
                onChange={() => setMode('managed-convex')}
              />
              <strong>Managed Convex</strong>
              <span>Vercel frontend plus generated Convex schema and functions.</span>
            </label>
          </div>

          <dl className={styles.summary}>
            <div>
              <dt>Pages</dt>
              <dd>{project.pages.length}</dd>
            </div>
            <div>
              <dt>Tables</dt>
              <dd>{project.data.tables.length}</dd>
            </div>
            <div>
              <dt>Seed records</dt>
              <dd>{project.data.tables.reduce((sum, table) => sum + table.seedRecords.length, 0)}</dd>
            </div>
          </dl>

          {diagnostics.length > 0 && (
            <div className={styles.diagnostics}>
              {diagnostics.map((diagnostic) => (
                <p key={`${diagnostic.code}:${diagnostic.path ?? ''}`}>{diagnostic.message}</p>
              ))}
            </div>
          )}
        </div>

        <div className={styles.panel}>
          <h2>Progress</h2>
          <ol className={styles.timeline}>
            {['queued', 'validating', 'compiling', 'deploying_convex', 'deploying_vercel', 'ready'].map((status) => (
              <li
                key={status}
                className={job?.status === status ? styles.timelineCurrent : undefined}
                data-complete={job && job.logs.includes(status) ? 'true' : undefined}
              >
                <span />
                {status.replace(/_/g, ' ')}
              </li>
            ))}
          </ol>
          {job?.status === 'failed' && <p className={styles.error}>{job.error ?? 'Publish failed.'}</p>}
          {error && <p className={styles.error}>{error}</p>}
          {job?.url && (
            <a className={styles.resultLink} href={job.url} target="_blank" rel="noreferrer">
              {job.url}
            </a>
          )}
          {job?.convexUrl && <p className={styles.convexUrl}>Convex: {job.convexUrl}</p>}
        </div>
      </section>

      <section className={styles.panel}>
        <h2>Logs</h2>
        <pre className={styles.logs}>{(job?.logs ?? ['No publish started.']).join('\n')}</pre>
      </section>
    </main>
  )
}

