import { useId, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import styles from './WorkspaceSection.module.css'
import ws from './SettingsWorkspace.module.css'

export function WorkspaceChoices({ title, children }: { title: string; children: ReactNode }) {
  const heading = useId()
  return (
    <section className={styles.choiceGroup} aria-labelledby={heading}>
      <h2 id={heading}>{title}</h2>
      <div className={styles.choiceGrid}>{children}</div>
    </section>
  )
}

export function WorkspaceChoice({ icon, label, description, active, onSelect }: {
  icon: ReactNode
  label: string
  description: ReactNode
  active: boolean
  onSelect: () => void
}) {
  return (
    <Button variant="ghost" size="md" fullWidth align="start" active={active}
      aria-current={active ? 'true' : undefined} onClick={onSelect} className={styles.choice}>
      {icon}
      <span className={ws.settingsListIdentity}>
        <span className={ws.settingsListLabel}>{label}</span>
        <span className={styles.choiceMeta}>{description}</span>
      </span>
    </Button>
  )
}
