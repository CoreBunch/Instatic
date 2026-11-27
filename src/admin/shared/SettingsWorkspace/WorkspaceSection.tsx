import { useId, type ReactNode } from 'react'
import styles from './WorkspaceSection.module.css'

export function WorkspaceSection({ title, actions, children }: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <header className={styles.sectionHeader}>
        <h1 id={headingId}>{title}</h1>
        {actions}
      </header>
      {children}
    </section>
  )
}
