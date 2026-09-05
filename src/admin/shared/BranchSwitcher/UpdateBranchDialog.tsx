/**
 * UpdateBranchDialog — review what updating a branch from main will change,
 * decide every conflict, then apply. Merging into main has its own page
 * (`/admin/branches/:id/review`); this dialog only ever updates the branch.
 *
 * The plan comes from the server; the dialog never guesses. A change with
 * conflicts renders a two-way choice — keep this side or take the other —
 * and the primary action stays disabled until every conflict has a
 * decision. The server re-plans on apply, so a change that landed after
 * the reviewer looked surfaces as a fresh conflict instead of being
 * applied unseen.
 */
import { useEffect, useState } from 'react'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import {
  type MergeChange,
  type MergePlan,
  type MergeResolution,
  type SiteBranch,
} from '@core/branches'
import { isAbortError } from '@core/http'
import { getCmsBranchMergePlan } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { mergeBranch } from '@admin/state/branchStore'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { useConfirmAction } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Skeleton } from '@ui/components/Skeleton'
import { TagPill } from '@ui/components/TagPill'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import styles from './UpdateBranchDialog.module.css'

interface UpdateBranchDialogProps {
  branch: SiteBranch
  onClose: () => void
}

const ACTION_LABEL: Record<MergeChange['action'], string> = {
  create: 'New',
  update: 'Changed',
  delete: 'Removed',
}

function groupLabel(change: MergeChange): string {
  if (change.kind === 'site') return 'Site'
  if (change.kind === 'table') return 'Tables'
  return change.tableName ? `${change.tableName} entries` : 'Entries'
}

function groupChanges(changes: MergeChange[]): Array<{ label: string; changes: MergeChange[] }> {
  const groups = new Map<string, MergeChange[]>()
  for (const change of changes) {
    const label = groupLabel(change)
    groups.set(label, [...(groups.get(label) ?? []), change])
  }
  return [...groups.entries()].map(([label, entries]) => ({ label, changes: entries }))
}

function describeConflicts(conflicts: string[]): string {
  if (conflicts.includes('(deleted)')) return 'Deleted on one side, changed on the other'
  const fields = conflicts.slice(0, 3).join(', ')
  return conflicts.length > 3 ? `Both sides changed ${fields} and ${conflicts.length - 3} more` : `Both sides changed ${fields}`
}

export function UpdateBranchDialog({ branch, onClose }: UpdateBranchDialogProps) {
  const { runStepUp } = useStepUp()
  const confirmAction = useConfirmAction()
  const [plan, setPlan] = useState<MergePlan | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [resolutions, setResolutions] = useState<Record<string, MergeResolution>>({})
  const [busy, setBusy] = useState(false)

  const title = `Update ${branch.name} from main`
  const intoLabel = 'Keep branch'
  const fromLabel = 'Take main'

  // Mounted fresh per open, so the plan state starts empty and needs no reset.
  useEffect(() => {
    const controller = new AbortController()
    getCmsBranchMergePlan(branch.id, 'update')
      .then((next) => {
        if (!controller.signal.aborted) setPlan(next)
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || controller.signal.aborted) return
        console.error('[branches] merge plan failed:', err)
        setLoadError(getErrorMessage(err, 'Could not compare the branches'))
      })
    return () => controller.abort()
  }, [branch.id])

  const unresolved = plan
    ? plan.changes.filter((change) => change.conflicts.length > 0 && !resolutions[change.key]).length
    : 0
  const total = plan?.changes.length ?? 0

  function apply(): void {
    if (!plan || busy || unresolved > 0) return
    confirmAction({
      title: `Update ${branch.name} from main?`,
      description: `${total} change${total === 1 ? '' : 's'} from main will be written over the branch's draft. Undo is offered right after, as long as the branch is not edited in between.`,
      confirmLabel: 'Update branch',
      commit: () => { void applyUpdate() },
    })
  }

  async function applyUpdate(): Promise<void> {
    if (!plan) return
    setBusy(true)
    try {
      const result = await runStepUp(() => mergeBranch(branch.id, 'update', { resolutions }))
      onClose()
      const count = result.plan.changes.length
      pushToast({
        kind: 'success',
        title: `Updated ${branch.name} from main`,
        body: `${count} change${count === 1 ? '' : 's'} from main now on the branch.`,
      })
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      console.error('[branches] merge failed:', err)
      pushToast({
        kind: 'error',
        title: 'Update failed',
        body: getErrorMessage(err, 'Unknown update error'),
      })
      // A conflict that appeared after the plan was loaded: reload it.
      getCmsBranchMergePlan(branch.id, 'update').then(setPlan).catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      eyebrow="Update"
      size="lg"
      footer={(
        <>
          <span className={styles.footerSpacer} aria-hidden="true" />
          <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            busy={busy}
            disabled={!plan || total === 0 || unresolved > 0}
            tooltip={unresolved > 0 ? `${unresolved} conflict${unresolved === 1 ? '' : 's'} still need a decision` : undefined}
            data-testid="branch-merge-apply"
            onClick={apply}
          >
            <ArrowDownIcon size={12} aria-hidden="true" />
            <span>{`Update with ${total} change${total === 1 ? '' : 's'}`}</span>
          </Button>
        </>
      )}
    >
      {loadError ? (
        <p className={styles.error} role="alert">{loadError}</p>
      ) : !plan ? (
        <div className={styles.loading} aria-busy="true" aria-label="Comparing branches">
          <Skeleton width="60%" height={14} radius={999} />
          <Skeleton width="80%" height={14} radius={999} />
          <Skeleton width="50%" height={14} radius={999} />
        </div>
      ) : total === 0 ? (
        <p className={styles.empty} data-testid="branch-merge-empty">
          {`${branch.name} already has everything on main.`}
        </p>
      ) : (
        <>
          <p className={styles.summary} data-testid="branch-merge-summary">
            {`${total} change${total === 1 ? '' : 's'} from main will land on the branch.`}
            {plan.conflictCount > 0 && (
              <>
                {' '}
                <strong>{plan.conflictCount} conflict{plan.conflictCount === 1 ? '' : 's'}</strong> need a decision.
              </>
            )}
          </p>
          {groupChanges(plan.changes).map((group) => (
            <section key={group.label} className={styles.group} aria-label={group.label}>
              <h3 className={styles.groupTitle}>{group.label}</h3>
              <ul className={styles.list}>
                {group.changes.map((change) => {
                  const conflicted = change.conflicts.length > 0
                  return (
                    <li
                      key={change.key}
                      className={cn(styles.row, conflicted && styles.rowConflict)}
                      data-testid={`branch-merge-change-${change.key}`}
                    >
                      <span className={styles.action}>
                        <TagPill label={ACTION_LABEL[change.action]} size="xs" />
                      </span>
                      <span className={styles.main}>
                        <span className={styles.label}>{change.label}</span>
                        {conflicted && (
                          <span className={styles.conflict}>{describeConflicts(change.conflicts)}</span>
                        )}
                      </span>
                      {conflicted && (
                        <SegmentedControl
                          value={resolutions[change.key]}
                          options={[
                            { value: 'into', label: intoLabel },
                            { value: 'from', label: fromLabel },
                          ]}
                          onChange={(next) => setResolutions((current) => ({ ...current, [change.key]: next }))}
                          size="xs"
                          aria-label={`Resolve ${change.label}`}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </Dialog>
  )
}
