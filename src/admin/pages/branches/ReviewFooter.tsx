/**
 * ReviewFooter — the review's decision bar. A manager decides here (keep or
 * delete the branch after merging, undo the last merge, decline, merge); a
 * requester waits or withdraws; everyone else asks for a merge. Presentation
 * only: every action is a callback the page owns, and the page runs the
 * confirmations, step-ups, and toasts.
 */
import type { BranchMergeRecord, BranchMergeRequest, MergePlan } from '@core/branches'
import { Button } from '@ui/components/Button'
import { Switch } from '@ui/components/Switch'
import { GitMergeSolidIcon } from 'pixel-art-icons/icons/git-merge-solid'
import { relativeIsoAgo } from './reviewFormat'
import styles from './BranchReviewPage.module.css'

interface ReviewFooterProps {
  canManage: boolean
  plan: MergePlan
  request: BranchMergeRequest | null
  /** The newest merge into main not yet undone; shows the undo control. */
  lastMerge: BranchMergeRecord | null
  unresolvedCount: number
  busy: boolean
  userId: string
  deleteAfter: boolean
  onDeleteAfterChange: (value: boolean) => void
  onMerge: () => void
  onUndo: () => void
  onDecline: () => void
  onWithdraw: () => void
  onRequest: () => void
}

export function ReviewFooter({
  canManage,
  plan,
  request,
  lastMerge,
  unresolvedCount,
  busy,
  userId,
  deleteAfter,
  onDeleteAfterChange,
  onMerge,
  onUndo,
  onDecline,
  onWithdraw,
  onRequest,
}: ReviewFooterProps) {
  const open = request?.status === 'open'
  const changeCountLabel = `${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}`

  return (
    <footer className={styles.footer} data-testid="branch-review-footer">
      {canManage ? (
        <>
          <label className={styles.footerToggle}>
            <Switch checked={deleteAfter} onCheckedChange={onDeleteAfterChange} switchSize="sm" aria-label="Delete branch after merging" data-testid="review-delete-toggle" />
            <span>Delete branch after merging{deleteAfter ? ' (cannot be undone)' : ''}</span>
          </label>
          <span className={styles.footerStatus}>
            {plan.changes.length === 0
              ? lastMerge
                ? `Merged ${relativeIsoAgo(lastMerge.createdAt)}. Undo puts main back while nothing on main has changed since.`
                : ''
              : unresolvedCount > 0
                ? `${unresolvedCount} conflict${unresolvedCount === 1 ? '' : 's'} still need${unresolvedCount === 1 ? 's' : ''} a decision.`
                : `Merging writes ${changeCountLabel} to main's draft.`}
          </span>
          {lastMerge && (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={busy}
              tooltip="Put main back the way it was before this merge"
              onClick={onUndo}
              data-testid="review-undo-merge"
            >
              Undo merge
            </Button>
          )}
          {open && (
            <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={onDecline} data-testid="review-decline-open">
              Decline…
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            type="button"
            busy={busy}
            disabled={busy || plan.changes.length === 0 || unresolvedCount > 0}
            tooltip={plan.changes.length === 0 ? 'Nothing to merge' : unresolvedCount > 0 ? `${unresolvedCount} conflict${unresolvedCount === 1 ? '' : 's'} still need a decision` : undefined}
            onClick={onMerge}
            data-testid="review-merge"
          >
            <GitMergeSolidIcon size={12} aria-hidden="true" />
            <span>Merge {changeCountLabel}</span>
          </Button>
        </>
      ) : open ? (
        <>
          <span className={styles.footerStatus}>Waiting for a branch manager to review.</span>
          {request.requestedBy?.id === userId && (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              busy={busy}
              onClick={onWithdraw}
              data-testid="review-withdraw"
            >
              Withdraw request
            </Button>
          )}
        </>
      ) : (
        <>
          <span className={styles.footerStatus}>
            {request?.status === 'declined'
              ? 'Fix what the note asks for, then request a merge again.'
              : request?.status === 'merged'
                ? 'The last request was merged. New work on this branch can be requested again.'
                : 'Request a merge when the branch is ready for review.'}
          </span>
          <Button variant="primary" size="sm" type="button" disabled={busy || plan.changes.length === 0} tooltip={plan.changes.length === 0 ? 'Nothing to merge yet' : undefined} onClick={onRequest} data-testid="review-request-open">
            {request?.status === 'declined' ? 'Request merge again…' : 'Request merge…'}
          </Button>
        </>
      )}
    </footer>
  )
}
