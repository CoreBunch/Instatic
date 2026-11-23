import { useId, type ReactNode } from 'react'
import styles from './EmailPage.module.css'

export function EmailSection({ title, description, actions, children }: {
  title: string
  description: string
  actions?: ReactNode
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <header className={styles.sectionHeader}>
        <div>
          <h1 id={headingId}>{title}</h1>
          <p>{description}</p>
        </div>
        {actions}
      </header>
      {children}
    </section>
  )
}
