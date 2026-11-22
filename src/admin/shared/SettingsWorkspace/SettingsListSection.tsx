import type { ReactNode } from 'react'
import styles from './SettingsWorkspace.module.css'

/** One labelled group of rows in a settings workspace browser column. */
export function SettingsListSection({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <section className={styles.settingsListSection}>
      <h3>{label}</h3>
      <div className={styles.settingsList}>{children}</div>
    </section>
  )
}
