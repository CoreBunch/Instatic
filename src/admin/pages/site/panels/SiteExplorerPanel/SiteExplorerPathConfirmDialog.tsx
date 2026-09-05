import { useRef } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import type { ExplorerPathChangePlan } from '@core/page-tree'
import styles from './SiteExplorerPathConfirmDialog.module.css'

interface SiteExplorerPathConfirmDialogProps {
  plan: ExplorerPathChangePlan
  onCancel: () => void
  onConfirm: () => void
}

export function SiteExplorerPathConfirmDialog({
  plan,
  onCancel,
  onConfirm,
}: SiteExplorerPathConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const hasBlockers = plan.blockers.length > 0
  const isDelete = plan.kind === 'delete'

  return (
    <Dialog
      open
      onClose={onCancel}
      tone={isDelete || hasBlockers ? 'danger' : 'neutral'}
      title={`${plan.operationLabel}?`}
      eyebrow="Site Explorer"
      size="lg"
      initialFocusRef={confirmRef}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant={isDelete ? 'destructive' : 'primary'}
            size="sm"
            type="button"
            disabled={hasBlockers}
            onClick={onConfirm}
          >
            {isDelete ? 'Delete' : 'Apply'}
          </Button>
        </>
      }
    >
      <p className={styles.summary}>{summaryForPlan(plan)}</p>

      {hasBlockers && (
        <div role="alert" className={styles.blockers}>
          <p className={styles.groupTitle}>This cannot be applied yet</p>
          <ul className={styles.list}>
            {plan.blockers.map((blocker) => (
              <li key={`${blocker.code}:${blocker.target}`} className={styles.listItem}>
                <span>{blocker.message}</span>
                <code className={styles.path}>{blocker.target}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.warnings.length > 0 && (
        <div className={styles.warnings}>
          <p className={styles.groupTitle}>Warnings</p>
          <ul className={styles.list}>
            {plan.warnings.map((warning) => (
              <li key={`${warning.code}:${warning.sourcePath ?? warning.message}`} className={styles.listItem}>
                <span>{warning.message}</span>
                {warning.sourcePath && <code className={styles.path}>{warning.sourcePath}</code>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.kind === 'rewrite' ? (
        <div className={styles.changeGroup}>
          <p className={styles.groupTitle}>Path changes</p>
          <ul className={styles.changeList}>
            {plan.changes.map((change) => (
              <li key={change.id} className={styles.changeItem}>
                <span className={styles.label}>{change.label}</span>
                <code className={styles.path}>{change.from}</code>
                <span className={styles.arrow}>to</span>
                <code className={styles.path}>{change.to}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className={styles.changeGroup}>
          <p className={styles.groupTitle}>Deleted items</p>
          <ul className={styles.changeList}>
            {plan.deletedItems.map((item) => (
              <li key={item.id} className={styles.changeItem}>
                <span className={styles.label}>{item.label}</span>
                <code className={styles.path}>{item.path}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  )
}

function summaryForPlan(plan: ExplorerPathChangePlan): string {
  if (plan.kind === 'delete') {
    const count = plan.deletedItems.length
    return `This will permanently delete ${count} ${count === 1 ? 'item' : 'items'} from ${sectionLabel(plan.sectionId)}.`
  }
  const count = plan.changes.length
  return `This will rewrite ${count} ${count === 1 ? 'path' : 'paths'} in ${sectionLabel(plan.sectionId)}.`
}

function sectionLabel(sectionId: ExplorerPathChangePlan['sectionId']): string {
  if (sectionId === 'pages') return 'Pages'
  if (sectionId === 'styles') return 'Styles'
  return 'Frontend scripts'
}
