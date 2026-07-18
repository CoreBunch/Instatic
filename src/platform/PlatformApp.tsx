import { useEffect, useState } from 'react'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { ArrowBarRightIcon } from 'pixel-art-icons/icons/arrow-bar-right'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { EmptyState } from '@ui/components/EmptyState'
import { Input } from '@ui/components/Input'
import { SearchBar } from '@ui/components/SearchBar'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import { ApiError } from '@core/http'
import {
  createPlatformOrganization,
  createPlatformProject,
  getPlatformSession,
  listPlatformProjects,
  logoutPlatform,
} from '@core/platform/api'
import type {
  PlatformSession,
  ProjectSourceMode,
  ProjectSummary,
} from '@core/platform/schemas'
import { getErrorMessage } from '@core/utils/errorMessage'
import styles from './PlatformApp.module.css'

const SOURCE_OPTIONS = [
  { value: 'instatic', label: 'Instatic Cloud' },
  { value: 'github', label: 'GitHub' },
  { value: 'local_bridge', label: 'Local Bridge' },
  { value: 'github_bridge', label: 'GitHub + Bridge' },
]

export function PlatformApp() {
  const [session, setSession] = useState<PlatformSession | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [createAgencyOpen, setCreateAgencyOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const nextSession = await getPlatformSession()
        if (cancelled) return
        setSession(nextSession)
        if (nextSession.organization) {
          const nextProjects = await listPlatformProjects()
          if (!cancelled) setProjects(nextProjects)
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          window.location.assign('/app/auth/login')
          return
        }
        console.error('[PlatformApp] Boot failed:', err)
        const message = getErrorMessage(err, 'Unknown platform error')
        setLoadError(message)
        pushToast({
          kind: 'error',
          title: 'Unable to load Instatic',
          body: message,
        })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  const visibleProjects = projects.filter((project) => {
    const haystack = `${project.name} ${project.clientName ?? ''}`.toLowerCase()
    return haystack.includes(query.trim().toLowerCase())
  })

  async function handleLogout() {
    try {
      const redirectTo = await logoutPlatform()
      window.location.assign(redirectTo)
    } catch (err) {
      console.error('[PlatformApp] Sign out failed:', err)
      pushToast({
        kind: 'error',
        title: 'Sign out failed',
        body: getErrorMessage(err, 'Unknown sign-out error'),
      })
    }
  }

  if (loading) return <PlatformLoading />
  if (!session) return <PlatformFailure message={loadError} />

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <a className={styles.brand} href="/app" aria-label="Instatic projects">
          <span className={styles.brandMark}><LayoutSolidIcon size={14} aria-hidden="true" /></span>
          <span>Instatic</span>
        </a>
        <div className={styles.account}>
          {session.organization && (
            <span className={styles.organizationName}>{session.organization.name}</span>
          )}
          <span className={styles.avatar} aria-hidden="true">
            {initials(session.user.name, session.user.email)}
          </span>
          <span className={styles.userName}>{session.user.name ?? session.user.email}</span>
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Sign out"
            tooltip="Sign out"
            onClick={() => void handleLogout()}
          >
            <ArrowBarRightIcon size={13} aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className={styles.workspace}>
        <aside className={styles.sidebar}>
          <nav aria-label="Platform navigation">
            <a className={styles.navItemActive} href="/app">
              <FolderGlyphIcon size={14} aria-hidden="true" />
              <span>Projects</span>
            </a>
            <span className={styles.navItemDisabled} aria-disabled="true">
              <UsersSolidIcon size={14} aria-hidden="true" />
              <span>Team</span>
            </span>
          </nav>
          <div className={styles.sidebarFooter}>
            <span className={styles.roleLabel}>{session.organization?.role ?? 'No agency'}</span>
            {session.authMode === 'development' && <span className={styles.devLabel}>Local</span>}
          </div>
        </aside>

        <main className={styles.main}>
          {!session.organization ? (
            <NoOrganization onCreate={() => setCreateAgencyOpen(true)} />
          ) : (
            <>
              <header className={styles.pageHeader}>
                <div>
                  <p className={styles.eyebrow}>{session.organization.name}</p>
                  <h1>Projects</h1>
                </div>
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => setCreateProjectOpen(true)}
                >
                  <PlusIcon size={12} aria-hidden="true" />
                  New project
                </Button>
              </header>

              <div className={styles.toolbar}>
                <SearchBar
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search projects"
                  aria-label="Search projects"
                  className={styles.search}
                />
                <span className={styles.resultCount}>
                  {visibleProjects.length} {visibleProjects.length === 1 ? 'project' : 'projects'}
                </span>
              </div>

              {visibleProjects.length === 0 ? (
                <EmptyState
                  variant="centered"
                  size="large"
                  plain
                  icon={<FolderGlyphIcon size={22} />}
                  title={projects.length === 0 ? 'No projects yet' : 'No matching projects'}
                  description={projects.length === 0 ? 'Create the first project for this agency.' : undefined}
                  action={projects.length === 0 ? (
                    <Button variant="secondary" size="md" onClick={() => setCreateProjectOpen(true)}>
                      <PlusIcon size={12} aria-hidden="true" />
                      New project
                    </Button>
                  ) : undefined}
                  className={styles.empty}
                />
              ) : (
                <ProjectTable projects={visibleProjects} />
              )}
            </>
          )}
        </main>
      </div>

      <CreateProjectDialog
        open={createProjectOpen}
        onClose={() => setCreateProjectOpen(false)}
        onCreated={(project) => {
          setProjects((current) => [project, ...current])
          setCreateProjectOpen(false)
        }}
      />
      <CreateAgencyDialog
        open={createAgencyOpen}
        onClose={() => setCreateAgencyOpen(false)}
        onCreated={(nextSession) => {
          setSession(nextSession)
          setCreateAgencyOpen(false)
        }}
      />
    </div>
  )
}

function ProjectTable({ projects }: { projects: ProjectSummary[] }) {
  return (
    <div className={styles.tableFrame}>
      <div className={styles.tableHeader} aria-hidden="true">
        <span>Project</span>
        <span>Source</span>
        <span>Workspace</span>
        <span>Updated</span>
        <span />
      </div>
      <div className={styles.tableBody}>
        {projects.map((project) => (
          <article className={styles.projectRow} key={project.id}>
            <div className={styles.projectIdentity}>
              <span className={styles.projectIcon}><LayoutSolidIcon size={15} aria-hidden="true" /></span>
              <span className={styles.projectText}>
                <strong>{project.name}</strong>
                <small>{project.clientName ?? project.slug}</small>
              </span>
            </div>
            <span className={styles.sourceLabel}>{sourceLabel(project.sourceMode)}</span>
            <span className={styles.workspaceState} data-state={project.workspaceState}>
              <i aria-hidden="true" />
              {workspaceLabel(project.workspaceState)}
            </span>
            <time dateTime={project.updatedAt}>{relativeTime(project.updatedAt)}</time>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label={`Open ${project.name}`}
              disabled={project.workspaceState !== 'ready'}
              tooltip={project.workspaceState === 'ready' ? 'Open project' : 'Workspace unavailable'}
            >
              <ChevronRightIcon size={13} aria-hidden="true" />
            </Button>
          </article>
        ))}
      </div>
    </div>
  )
}

function CreateProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (project: ProjectSummary) => void
}) {
  const [name, setName] = useState('')
  const [clientName, setClientName] = useState('')
  const [sourceMode, setSourceMode] = useState<ProjectSourceMode>('instatic')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      const project = await createPlatformProject({
        name: name.trim(),
        clientName: clientName.trim() || null,
        sourceMode,
      })
      setName('')
      setClientName('')
      setSourceMode('instatic')
      onCreated(project)
    } catch (err) {
      console.error('[CreateProjectDialog] Project creation failed:', err)
      pushToast({
        kind: 'error',
        title: 'Project creation failed',
        body: getErrorMessage(err, 'Unknown project error'),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      eyebrow="Projects"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!name.trim() || saving}>
            {saving ? 'Creating...' : 'Create project'}
          </Button>
        </>
      )}
    >
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <label>
          <span>Project name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            maxLength={120}
            required
          />
        </label>
        <label>
          <span>Client</span>
          <Input
            value={clientName}
            onChange={(event) => setClientName(event.target.value)}
            autoComplete="organization"
            maxLength={120}
          />
        </label>
        <label>
          <span>Source</span>
          <Select
            value={sourceMode}
            onChange={(event) => setSourceMode(event.target.value as ProjectSourceMode)}
            options={SOURCE_OPTIONS}
          />
        </label>
      </form>
    </Dialog>
  )
}

function NoOrganization({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      variant="centered"
      size="large"
      plain
      icon={<UsersSolidIcon size={24} />}
      title="Create your agency"
      description="Projects and team access are organized inside an agency."
      action={<Button variant="primary" size="md" onClick={onCreate}>Create agency</Button>}
      className={styles.empty}
    />
  )
}

function CreateAgencyDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (session: PlatformSession) => void
}) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (name.trim().length < 2 || saving) return
    setSaving(true)
    try {
      const nextSession = await createPlatformOrganization(name.trim())
      setName('')
      onCreated(nextSession)
    } catch (err) {
      console.error('[CreateAgencyDialog] Agency creation failed:', err)
      pushToast({
        kind: 'error',
        title: 'Agency creation failed',
        body: getErrorMessage(err, 'Unknown agency error'),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create agency"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={name.trim().length < 2 || saving}>
            {saving ? 'Creating...' : 'Create agency'}
          </Button>
        </>
      )}
    >
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <label>
          <span>Agency name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="organization"
            maxLength={120}
            required
          />
        </label>
      </form>
    </Dialog>
  )
}

function PlatformLoading() {
  return (
    <main className={styles.loading} aria-label="Loading projects">
      <span className={styles.loadingMark}><LayoutSolidIcon size={18} aria-hidden="true" /></span>
    </main>
  )
}

function PlatformFailure({ message }: { message: string | null }) {
  return (
    <main className={styles.loading}>
      <EmptyState
        variant="centered"
        size="large"
        plain
        icon={<LayoutSolidIcon size={22} />}
        title="Unable to load projects"
        description={message ?? 'The managed platform is unavailable.'}
        action={(
          <Button variant="secondary" size="md" onClick={() => window.location.reload()}>
            Retry
          </Button>
        )}
      />
    </main>
  )
}

function initials(name: string | null, email: string): string {
  const source = name?.trim() || email.split('@')[0] || 'I'
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

function sourceLabel(mode: ProjectSourceMode): string {
  return SOURCE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
}

function workspaceLabel(state: ProjectSummary['workspaceState']): string {
  if (state === 'ready') return 'Ready'
  if (state === 'provisioning') return 'Provisioning'
  if (state === 'error') return 'Needs attention'
  return 'Not provisioned'
}

function relativeTime(value: string): string {
  const timestamp = new Date(value).getTime()
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1_000)
  const absolute = Math.abs(deltaSeconds)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (absolute < 60) return formatter.format(deltaSeconds, 'second')
  if (absolute < 3_600) return formatter.format(Math.round(deltaSeconds / 60), 'minute')
  if (absolute < 86_400) return formatter.format(Math.round(deltaSeconds / 3_600), 'hour')
  return formatter.format(Math.round(deltaSeconds / 86_400), 'day')
}
