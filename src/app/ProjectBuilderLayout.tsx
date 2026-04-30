import { Outlet, useParams } from 'react-router-dom'
import { SettingsModal } from '@editor/components/Settings'
import { usePersistence } from '@editor/hooks/usePersistence'
import { ProjectWorkspaceNav } from './components/ProjectWorkspaceNav/ProjectWorkspaceNav'
import styles from './ProjectBuilderLayout.module.css'

export default function ProjectBuilderLayout() {
  const { projectId } = useParams<{ projectId: string }>()

  usePersistence(projectId)

  return (
    <div className={styles.shell}>
      <ProjectWorkspaceNav />
      <div className={styles.workspace}>
        <Outlet />
      </div>
      <SettingsModal />
    </div>
  )
}

