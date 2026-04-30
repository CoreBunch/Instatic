import { NavLink, useParams } from 'react-router-dom'
import { useEditorStore } from '@core/editor-store/store'
import type { DataTable } from '@core/data-model/types'
import { Icon } from '@ui/icons/Icon'
import styles from './ProjectWorkspaceNav.module.css'

const EMPTY_TABLES: DataTable[] = []

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? `${styles.item} ${styles.itemActive}` : styles.item
}

export function ProjectWorkspaceNav() {
  const { projectId } = useParams<{ projectId: string }>()
  const project = useEditorStore((state) => state.project)
  const base = `/projects/${projectId ?? 'new-project'}`
  const tables = project?.data.tables ?? EMPTY_TABLES
  const pinnedTables = tables.filter((table) => table.pinned).slice(0, 5)

  return (
    <header className={styles.bar} aria-label="Project workspaces">
      <div className={styles.brand} title={project?.name ?? 'Untitled Project'}>
        <Icon name="layout" size={14} aria-hidden="true" />
        <span>{project?.name ?? 'Untitled Project'}</span>
      </div>

      <nav className={styles.nav} aria-label="Project workspace navigation">
        <NavLink to={`${base}/editor`} className={navClass}>
          <Icon name="cursor" size={14} aria-hidden="true" />
          <span>Editor</span>
        </NavLink>
        <NavLink to={`${base}/database`} className={navClass}>
          <Icon name="database" size={14} aria-hidden="true" />
          <span>Database</span>
        </NavLink>
        {pinnedTables.map((table) => (
          <NavLink key={table.id} to={`${base}/resources/${table.slug}`} className={navClass}>
            <Icon name="table-row-plus" size={14} aria-hidden="true" />
            <span>{table.name}</span>
          </NavLink>
        ))}
        <NavLink to={`${base}/publish`} className={navClass}>
          <Icon name="upload" size={14} aria-hidden="true" />
          <span>Publish</span>
        </NavLink>
      </nav>
    </header>
  )
}
