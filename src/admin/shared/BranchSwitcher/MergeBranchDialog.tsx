/**
 * MergeBranchDialog — review what a merge (branch → main) or an update
 * (main → branch) will change, decide every conflict, then apply.
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
import { GitMergeSolidIcon } from 'pixel-art-icons/icons/git-merge-solid'
import {
  type MergeChange,
  type MergeDirection,
  type MergePlan,
  type MergeResolution,
  type SiteBranch,
} from '@core/branches'
import { isAbortError } from '@core/http'
import { getCmsBranchMergePlan } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { mergeBranch } from '@admin/state/branchStore'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Skeleton } from '@ui/components/Skeleton'
import { Switch } from '@ui/components/Switch'
import { TagPill } from '@ui/components/TagPill'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import styles from './MergeBranchDialog.module.css'

interface MergeBranchDialogProps {
  branch: SiteBranch
  direction: MergeDirection
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

export function MergeBranchDialog({ branch, direction, onClose }: MergeBranchDialogProps) {
  const { runStepUp } = useStepUp()
  const [plan, setPlan] = useState<MergePlan | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [resolutions, setResolutions] = useState<Record<string, MergeResolution>>({})
  const [deleteAfter, setDeleteAfter] = useState(direction === 'merge')
  const [busy, setBusy] = useState(false)

  const isMerge = direction === 'merge'
  const title = isMerge ? `Merge ${branch.name} into main` : `Update ${branch.name} from main`
  const intoLabel = isMerge ? 'Keep main' : 'Keep branch'
  const fromLabel = isMerge ? 'Take branch' : 'Take main'

  // Mounted fresh per open (keyed by direction in the strip), so the plan
  // state starts empty and needs no reset here.
  useEffect(() => {
    const controller = new AbortController()
    getCmsBranchMergePlan(branch.id, direction)
      .then((next) => {
        if (!controller.signal.aborted) setPlan(next)
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || controller.signal.aborted) return
        console.error('[branches] merge plan failed:', err)
        setLoadError(getErrorMessage(err, 'Could not compare the branches'))
      })
    return () => controller.abort()
  }, [branch.id, direction])

  const unresolved = plan
    ? plan.changes.filter((change) => change.conflicts.length > 0 && !resolutions[change.key]).length
    : 0
  const total = plan?.changes.length ?? 0

  async function apply(): Promise<void> {
    if (!plan || busy || unresolved > 0) return
    setBusy(true)
    try {
      const result = await runStepUp(() =>
        mergeBranch(branch.id, direction, { resolutions, deleteBranch: isMerge && deleteAfter }),
      )
      onClose()
      const count = result.plan.changes.length
      pushToast({
        kind: 'success',
        title: isMerge ? `Merged ${branch.name} into main` : `Updated ${branch.name} from main`,
        body: isMerge
          ? `${count} change${count === 1 ? '' : 's'} landed in main's draft. Publish when you're ready.${result.branchDeleted ? ' The branch was deleted.' : ''}`
          : `${count} change${count === 1 ? '' : 's'} from main now on the branch.`,
      })
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      console.error('[branches] merge failed:', err)
      pushToast({
        kind: 'error',
        title: isMerge ? 'Merge failed' : 'Update failed',
        body: getErrorMessage(err, 'Unknown merge error'),
      })
      // A conflict that appeared after the plan was loaded: reload it.
      getCmsBranchMergePlan(branch.id, direction).then(setPlan).catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      eyebrow={isMerge ? 'Merge' : 'Update'}
      size="lg"
      footer={(
        <>
          {isMerge && (
            <label className={styles.deleteToggle}>
              <Switch
                checked={deleteAfter}
                onCheckedChange={setDeleteAfter}
                switchSize="sm"
                aria-label="Delete branch after merging"
                data-testid="branch-merge-delete-toggle"
              />
              <span>Delete branch after merging</span>
            </label>
          )}
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
            onClick={() => { void apply() }}
          >
            {isMerge ? <GitMergeSolidIcon size={12} aria-hidden="true" /> : <ArrowDownIcon size={12} aria-hidden="true" />}
            <span>
              {isMerge
                ? `Merge ${total} change${total === 1 ? '' : 's'}`
                : `Update with ${total} change${total === 1 ? '' : 's'}`}
            </span>
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
          {isMerge
            ? `${branch.name} has no changes that main does not already have.`
            : `${branch.name} already has everything on main.`}
        </p>
      ) : (
        <>
          <p className={styles.summary} data-testid="branch-merge-summary">
            {isMerge
              ? `${total} change${total === 1 ? '' : 's'} will land in main's draft.`
              : `${total} change${total === 1 ? '' : 's'} from main will land on the branch.`}
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
