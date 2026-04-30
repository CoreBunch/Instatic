/**
 * Dashboard — project list + new project CTA.
 *
 * Phase B: Full redesign — Vercel/Linear dark aesthetic with CSS Modules + tokens.
 * Kept all WCAG 2.5.5 touch targets, aria-label attributes and data-testids.
 */
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { localAdapter } from '@core/persistence'
import type { ProjectSummary } from '@core/persistence'
import { nanoid } from 'nanoid'
import { Icon } from '../ui/icons/Icon'
import { Button } from '@ui/components/Button'
import styles from './Dashboard.module.css'

export default function Dashboard() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await localAdapter.listProjects()
      setProjects(list)
    } catch (err) {
      console.warn('[Dashboard] Failed to list projects:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadProjects() {
      try {
        const list = await localAdapter.listProjects()
        if (!cancelled) setProjects(list)
      } catch (err) {
        console.warn('[Dashboard] Failed to list projects:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadProjects()
    return () => { cancelled = true }
  }, [])

  const handleNewProject = () => {
    const newId = nanoid()
    navigate(`/projects/${newId}/editor`)
  }

  const handleOpen = (id: string) => {
    navigate(`/projects/${id}/editor`)
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (!confirm('Delete this project? This cannot be undone.')) return
    setDeletingId(id)
    try {
      await localAdapter.deleteProject(id)
      await refresh()
    } catch (err) {
      console.error('[Dashboard] Delete failed:', err)
    } finally {
      setDeletingId(null)
    }
  }

  const formatDate = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div className={styles.page}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className={styles.header}>
        {/* Logo */}
        <div className={styles.logoGroup}>
          <div className={styles.logoIcon}>
            <Icon name="layout" size={14} color="#ededed" aria-hidden="true" />
          </div>
          <span className={styles.logoText}>
            Page Builder
          </span>
        </div>

        {/* New project button */}
        <Button
          variant="primary"
          size="lg"
          accentFill
          onClick={handleNewProject}
          aria-label="Create a new project"
        >
          <Icon name="plus" size={14} aria-hidden="true" />
          New Project
        </Button>
      </header>

      {/* ── Main ──────────────────────────────────────────────────────────── */}
      <main className={styles.main}>

        {/* Section label */}
        <h2 className={styles.sectionLabel}>
          {loading ? 'Loading…' : projects.length === 0 ? 'No projects yet' : `Projects — ${projects.length}`}
        </h2>

        {/* Empty state */}
        {!loading && projects.length === 0 && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <Icon name="file-plus" size={24} color="#52525b" aria-hidden="true" />
            </div>
            <div className={styles.emptyText}>
              <p className={styles.emptyTitle}>No projects yet</p>
              <p className={styles.emptyHint}>Create your first project to get started.</p>
            </div>
            <Button
              variant="primary"
              size="lg"
              accentFill
              onClick={handleNewProject}
            >
              <Icon name="plus" size={14} aria-hidden="true" />
              New Project
            </Button>
          </div>
        )}

        {/* Project grid */}
        <ul role="list" className={styles.grid}>
          {projects.map((project) => (
            <li key={project.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => handleOpen(project.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleOpen(project.id)
                  }
                }}
                aria-label={`Open ${project.name}`}
                className={styles.card}
              >
                {/* Thumbnail placeholder */}
                <div className={styles.thumbnail} aria-hidden="true">
                  <Icon name="layout" size={24} color="#3f3f46" />
                </div>

                {/* Project info + delete */}
                <div className={styles.cardInfo}>
                  <div className={styles.cardMeta}>
                    <div className={styles.cardName}>
                      {project.name}
                    </div>
                    <div className={styles.cardDate}>
                      {project.pageCount} page{project.pageCount !== 1 ? 's' : ''} · {formatDate(project.updatedAt)}
                    </div>
                  </div>

                  {/* Delete button — WCAG 2.5.5: min 44px touch target */}
                  <Button
                    variant="destructive"
                    size="lg"
                    iconOnly
                    onClick={(e) => handleDelete(e, project.id)}
                    disabled={deletingId === project.id}
                    aria-label={`Delete ${project.name}`}
                    title="Delete project"
                  >
                    <Icon name="delete" size={14} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
