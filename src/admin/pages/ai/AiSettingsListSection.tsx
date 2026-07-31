import type { ReactNode } from 'react'
import styles from './AiPage.module.css'

export function AiSettingsListSection({
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
