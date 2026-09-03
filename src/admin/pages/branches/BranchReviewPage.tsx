/**
 * BranchReviewPage — the merge review of one branch
 * (`/admin/branches/:branchId/review`).
 *
 * One timeline: the merge request opens it (its note, status, and what
 * merging grants), then one node per change the plan lists — a page as
 * before/after frames, an entry as a field table, a table as its schema,
 * a file as a line diff — each with its own comment thread, and the
 * decision closes it. Conflicts are decided in place; the footer's merge
 * stays disabled until every one has a side. Merging runs the same
 * step-up-gated apply the branch strip used to run from a dialog.
 */
import { useEffect, useState } from 'react'
import { MAIN_BRANCH_ID, type MergeChange, type MergeResolution, type ReviewUserLabel } from '@core/branches'
import { getErrorMessage } from '@core/utils/errorMessage'
import { AdminWorkspaceCanvasLayout } from '@admin/layouts/AdminWorkspaceCanvasLayout/AdminWorkspaceCanvasLayout'
import { useNavigate, useParams } from '@admin/lib/routing'
import { hasCapability } from '@admin/access'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { mergeBranch, refreshBranches, switchBranch, useActiveBranchId, useBranchStore } from '@admin/state/branchStore'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { UserAvatar } from '@admin/shared/UserAvatar/UserAvatar'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { FilterBar } from '@ui/components/FilterBar'
import { Textarea } from '@ui/components/Input'
import { Skeleton } from '@ui/components/Skeleton'
import { Switch } from '@ui/components/Switch'
import { pushToast } from '@ui/components/Toast'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { GitMergeSolidIcon } from 'pixel-art-icons/icons/git-merge-solid'
import { ReviewChangeCard } from './ReviewChangeCard'
import { ReviewThread } from './ReviewThread'
import {
  ACTION_LETTER,
  ACTION_WORD,
  FILTER_LABELS,
  REQUEST_ENTITY_KEY,
  REVIEW_FILTERS,
  isPageChange,
  matchesFilter,
  relativeIso,
  requestStatusLabel,
  requestStatusTone,
  type ReviewFilter,
} from './reviewFormat'
import { useBranchReview } from './useBranchReview'
import styles from './BranchReviewPage.module.css'

export function BranchReviewPage() {
  const params = useParams<{ branchId: string }>()
  const branchId = params.branchId ?? ''
  const branches = useBranchStore((state) => state.branches)
  const branchesLoaded = useBranchStore((state) => state.branchesLoaded)
  const activeBranchId = useActiveBranchId()
  const branch = branches.find((candidate) => candidate.id === branchId) ?? null

  useEffect(() => {
    if (!branchesLoaded) void refreshBranches()
  }, [branchesLoaded])

  // Reviewing a branch means being on it: "back to the editor" lands there,
  // and the toolbar strip names what is being reviewed.
  useEffect(() => {
    if (branch && activeBranchId !== branch.id) switchBranch(branch.id)
  }, [branch, activeBranchId])

  if (!branchesLoaded || !branch || branch.id === MAIN_BRANCH_ID) {
    return (
      <AdminWorkspaceCanvasLayout
        workspace="branchReview"
        contentCanvas={(
          <div className={styles.canvas}>
            {branchesLoaded ? (
              <div className={styles.state} role="alert">
                {branch?.id === MAIN_BRANCH_ID
                  ? 'Main is the live site; it is what branches merge into.'
                  : `There is no branch “${branchId}”.`}
              </div>
            ) : (
              <div className={styles.loading} aria-busy="true" aria-label="Loading the branch">
                <Skeleton width="40%" height={14} radius={999} />
                <Skeleton width="70%" height={14} radius={999} />
              </div>
            )}
          </div>
        )}
      />
    )
  }
  return <Review key={branch.id} branchId={branch.id} branchName={branch.name} />
}

interface ReviewProps {
  branchId: string
  branchName: string
}

function Review({ branchId, branchName }: ReviewProps) {
  const navigate = useNavigate()
  const user = useAuthenticatedAdminUser()
  const canManage = hasCapability(user, 'site.branches.manage')
  const { runStepUp } = useStepUp()
  const data = useBranchReview(branchId)
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const [resolutions, setResolutions] = useState<Record<string, MergeResolution>>({})
  const [deleteAfter, setDeleteAfter] = useState(true)
  const [dialog, setDialog] = useState<'request' | 'decline' | null>(null)
  const [busy, setBusy] = useState(false)

  const me: ReviewUserLabel = {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    gravatarHash: user.gravatarHash,
  }

  const { plan, review } = data
  if (data.loadError) {
    return (
      <AdminWorkspaceCanvasLayout
        workspace="branchReview"
        contentCanvas={(
          <div className={styles.canvas}>
            <div className={styles.state} role="alert">
              <span>{data.loadError}</span>
              <Button variant="secondary" size="sm" type="button" onClick={() => { void data.reload() }}>
                Try again
              </Button>
            </div>
          </div>
        )}
      />
    )
  }
  if (!plan || !review) {
    return (
      <AdminWorkspaceCanvasLayout
        workspace="branchReview"
        contentCanvas={(
          <div className={styles.canvas}>
            <div className={styles.loading} aria-busy="true" aria-label="Comparing the branch with main">
              <Skeleton width="40%" height={14} radius={999} />
              <Skeleton width="70%" height={14} radius={999} />
              <Skeleton width="55%" height={14} radius={999} />
            </div>
          </div>
        )}
      />
    )
  }

  // Narrowed copies for the closures below (TS drops the narrowing inside them).
  const loadedPlan = plan
  const request = review.request
  const open = request?.status === 'open'
  const stale = open && request.contentHash !== review.contentHash
  const commentsFor = (key: string) => review.comments.filter((comment) => comment.entityKey === key)
  const unresolved = plan.changes.filter((change) => change.conflicts.length > 0 && !resolutions[change.key])
  const visible = plan.changes.filter((change) => matchesFilter(change, filter, commentsFor(change.key).length))
  const counts = {
    pages: plan.changes.filter(isPageChange).length,
    entries: plan.changes.filter((change) => change.kind === 'row' && !isPageChange(change)).length,
    tables: plan.changes.filter((change) => change.kind === 'table').length,
    files: plan.changes.filter((change) => change.kind === 'file').length,
    site: plan.changes.filter((change) => change.kind === 'site').length,
  }
  const filterCount = (id: ReviewFilter): number =>
    plan.changes.filter((change) => matchesFilter(change, id, commentsFor(change.key).length)).length

  async function withBusy(label: string, action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true)
    try {
      await action()
      return true
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return false
      console.error(`[branch-review] ${label} failed:`, err)
      pushToast({ kind: 'error', title: `Could not ${label}`, body: getErrorMessage(err, 'Unknown review error') })
      // A request that changed under us is the usual cause: show the truth.
      void data.reload()
      return false
    } finally {
      setBusy(false)
    }
  }

  async function merge(): Promise<void> {
    if (unresolved.length > 0 || loadedPlan.changes.length === 0) return
    const done = await withBusy('merge the branch', async () => {
      const result = await runStepUp(() => mergeBranch(branchId, 'merge', { resolutions, deleteBranch: deleteAfter }))
      const count = result.plan.changes.length
      pushToast({
        kind: 'success',
        title: `Merged ${branchName} into main`,
        body: `${count} change${count === 1 ? '' : 's'} landed in main's draft. Publish when you're ready.${result.branchDeleted ? ' The branch was deleted.' : ''}`,
      })
    })
    if (done) navigate('/admin/site')
  }

  const changeCountLabel = `${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}`
  const title = request?.status === 'declined'
    ? `Changes requested on ${branchName}`
    : request?.status === 'merged'
      ? `${branchName} was merged into main`
      : `Merge ${branchName} into main`

  return (
    <AdminWorkspaceCanvasLayout
      workspace="branchReview"
      contentCanvas={(
        <div className={styles.canvas} data-testid="branch-review">
          <div className={styles.page}>
            <div className={styles.scroll}>
              <header className={styles.header}>
                <div className={styles.eyebrow}>
                  <span>Merge review</span>
                  <span>·</span>
                  <span>{branchName} → main</span>
                </div>
                <h1 className={styles.title} data-testid="branch-review-title">{title}</h1>
                <div className={styles.meta}>
                  {request ? (
                    <span>
                      <strong>{request.requestedBy?.displayName ?? 'Removed user'}</strong> requested {relativeIso(request.createdAt)} ago
                    </span>
                  ) : (
                    <span>No merge request yet</span>
                  )}
                  <span>{changeCountLabel}</span>
                  {plan.conflictCount > 0 && (
                    <span className={styles.del}>{plan.conflictCount} conflict{plan.conflictCount === 1 ? '' : 's'}</span>
                  )}
                  <span>{review.comments.length} comment{review.comments.length === 1 ? '' : 's'}</span>
                  {request && <StatusPill status={request.status} unresolved={open ? unresolved.length : 0} />}
                </div>
                <div className={styles.filters}>
                  <FilterBar
                    items={REVIEW_FILTERS.map((id) => ({
                      value: id,
                      label: (
                        <>
                          {FILTER_LABELS[id]}
                          <span className={styles.filterCount}>{filterCount(id)}</span>
                        </>
                      ),
                      ariaLabel: `${FILTER_LABELS[id]}, ${filterCount(id)}`,
                    }))}
                    value={filter}
                    onValueChange={setFilter}
                    groupLabel="Filter changes"
                  />
                </div>
              </header>

              <div className={styles.timeline}>
                {filter === 'all' && (
                  <TimelineNode
                    id="review-request"
                    marker={request?.requestedBy ? <UserAvatar user={request.requestedBy} size={22} /> : <span className={styles.dot} />}
                    left={(
                      <ReviewThread
                        title="Conversation"
                        comments={commentsFor(REQUEST_ENTITY_KEY)}
                        me={me}
                        placeholder="Comment on the request"
                        onPost={(body) => data.comment(REQUEST_ENTITY_KEY, body)}
                        testId="review-thread-request"
                      />
                    )}
                    right={(
                      <section className={styles.card} data-testid="review-request-card">
                        {request ? (
                          <>
                            <div className={styles.cardHead}>
                              {request.requestedBy && <UserAvatar user={request.requestedBy} size={18} />}
                              <strong>{request.requestedBy?.displayName ?? 'Removed user'}</strong>
                              <span>asked to merge {branchName} into main</span>
                              <span>{relativeIso(request.createdAt)}</span>
                              <span className={styles.spacer} />
                              <StatusPill status={request.status} unresolved={open ? unresolved.length : 0} />
                            </div>
                            {request.note ? (
                              <p className={styles.requestNote}>{request.note}</p>
                            ) : (
                              <p className={styles.cardEmpty}>No note.</p>
                            )}
                          </>
                        ) : (
                          <>
                            <div className={styles.cardHead}>
                              <strong>No merge request yet</strong>
                            </div>
                            <div className={styles.requestEmpty}>
                              <span>
                                {canManage
                                  ? 'You can merge from the bar below, or ask another manager to review by requesting a merge.'
                                  : 'When the branch is ready, request a merge so a branch manager reviews it.'}
                              </span>
                              <div>
                                <Button variant="secondary" size="sm" type="button" onClick={() => setDialog('request')} data-testid="review-request-open">
                                  Request merge…
                                </Button>
                              </div>
                            </div>
                          </>
                        )}
                        <div className={styles.facts}>
                          <div className={styles.fact}>
                            <span className={styles.factLabel}>Changes</span>
                            <span className={styles.factValue}>
                              {plan.changes.length === 0
                                ? 'Main already has everything on this branch.'
                                : [
                                    counts.pages > 0 ? `${counts.pages} page${counts.pages === 1 ? '' : 's'}` : null,
                                    counts.entries > 0 ? `${counts.entries} entr${counts.entries === 1 ? 'y' : 'ies'}` : null,
                                    counts.tables > 0 ? `${counts.tables} table${counts.tables === 1 ? '' : 's'}` : null,
                                    counts.files > 0 ? `${counts.files} file${counts.files === 1 ? '' : 's'}` : null,
                                    counts.site > 0 ? 'site settings' : null,
                                  ].filter(Boolean).join(', ')}
                            </span>
                          </div>
                          <div className={styles.fact}>
                            <span className={styles.factLabel}>Conflicts</span>
                            <span className={styles.factValue}>
                              {plan.conflictCount === 0
                                ? 'None. Main did not touch what the branch changed.'
                                : unresolved.length === 0
                                  ? `${plan.conflictCount} decided.`
                                  : `${unresolved.length} need${unresolved.length === 1 ? 's' : ''} a decision before merging.`}
                            </span>
                          </div>
                          <div className={styles.fact}>
                            <span className={styles.factLabel}>Freshness</span>
                            <span className={styles.factValue}>
                              {!request
                                ? 'Compared against main as of now.'
                                : stale
                                  ? 'The branch changed after this request was made; the changes below are current.'
                                  : 'The branch is unchanged since the request.'}
                            </span>
                          </div>
                          <div className={styles.fact}>
                            <span className={styles.factLabel}>What merging does</span>
                            <span className={styles.factValue}>
                              Writes every change to main's draft and mirrors the result onto the branch. Nothing is published.
                            </span>
                          </div>
                        </div>
                      </section>
                    )}
                  />
                )}

                {plan.changes.length === 0 && (
                  <div className={styles.state}>Nothing to review: main already has everything on this branch.</div>
                )}

                {visible.map((change) => (
                  <TimelineNode
                    key={change.key}
                    id={`review-change-${change.key}`}
                    marker={(
                      <span className={styles.actionBadge} data-action={change.action} aria-label={ACTION_WORD[change.action]}>
                        {ACTION_LETTER[change.action]}
                      </span>
                    )}
                    left={(
                      <ReviewThread
                        title={change.kind === 'row' && change.tableName && !isPageChange(change) ? `${change.tableName}: ${change.label}` : change.label}
                        comments={commentsFor(change.key)}
                        me={me}
                        placeholder={threadPlaceholder(change)}
                        onPost={(body) => data.comment(change.key, body)}
                        testId={`review-thread-${change.key}`}
                      />
                    )}
                    right={(
                      <ReviewChangeCard
                        branchId={branchId}
                        change={change}
                        resolution={resolutions[change.key]}
                        canResolve={canManage && (request === null || open)}
                        onResolve={(resolution) => setResolutions((current) => ({ ...current, [change.key]: resolution }))}
                      />
                    )}
                  />
                ))}

                {filter === 'all' && request && (
                  <TimelineNode
                    id="review-decision"
                    last
                    marker={request.resolvedBy ? <UserAvatar user={request.resolvedBy} size={22} /> : <span className={styles.dot} />}
                    left={(
                      <div className={styles.thread} data-testid="review-decision">
                        <div className={styles.threadHead}>
                          <span className={styles.threadTitle}>Decision</span>
                          <span className={styles.spacer} />
                          <StatusPill status={request.status} unresolved={open ? unresolved.length : 0} />
                        </div>
                        {request.status === 'declined' && (
                          <div className={styles.decision} data-tone="danger">
                            <div className={styles.decisionWho}>
                              {request.resolvedBy && <UserAvatar user={request.resolvedBy} size={18} />}
                              <strong>{request.resolvedBy?.displayName ?? 'A branch manager'}</strong>
                              <span>declined · {request.resolvedAt ? relativeIso(request.resolvedAt) : ''}</span>
                            </div>
                            <p>{request.resolutionNote}</p>
                          </div>
                        )}
                        {request.status === 'merged' && (
                          <div className={styles.decision} data-tone="success">
                            <div className={styles.decisionWho}>
                              <CheckIcon size={12} aria-hidden="true" />
                              <strong>{request.resolvedBy?.displayName ?? 'A branch manager'}</strong>
                              <span>merged · {request.resolvedAt ? relativeIso(request.resolvedAt) : ''}</span>
                            </div>
                            <p>The changes are in main's draft. Publish main when you are ready.</p>
                          </div>
                        )}
                        {request.status === 'withdrawn' && (
                          <div className={styles.decision}>
                            <p className={styles.hint}>The request was withdrawn. Request again when the branch is ready.</p>
                          </div>
                        )}
                        {open && (
                          <div className={styles.decision}>
                            <p className={styles.hint}>
                              {canManage ? 'Merge or decline in the bar below.' : 'Waiting for a branch manager.'}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                    right={(
                      <section className={styles.card}>
                        <div className={styles.cardHead}>
                          <strong>{open ? 'What the decision does' : 'Outcome'}</strong>
                        </div>
                        {open ? (
                          <div className={styles.facts}>
                            <div className={styles.fact}>
                              <span className={styles.factLabel}>Merge</span>
                              <span className={styles.factValue}>Writes every change to main's draft, mirrors the result to the branch, and deletes the branch if chosen. Asks for a password.</span>
                            </div>
                            <div className={styles.fact}>
                              <span className={styles.factLabel}>Decline</span>
                              <span className={styles.factValue}>Needs a note. The requester sees it here and can request again after fixing the branch.</span>
                            </div>
                          </div>
                        ) : (
                          <p className={styles.requestNote}>
                            {request.status === 'declined'
                              ? 'The branch stays as it is. Fix what the note asks for and request a merge again; every comment above stays with the branch.'
                              : request.status === 'merged'
                                ? 'Main’s draft now holds these changes. Publish main to make them live.'
                                : 'Nothing was merged.'}
                          </p>
                        )}
                      </section>
                    )}
                  />
                )}
              </div>
            </div>

            <footer className={styles.footer} data-testid="branch-review-footer">
              {canManage ? (
                <>
                  <label className={styles.footerToggle}>
                    <Switch checked={deleteAfter} onCheckedChange={setDeleteAfter} switchSize="sm" aria-label="Delete branch after merging" data-testid="review-delete-toggle" />
                    <span>Delete branch after merging</span>
                  </label>
                  <span className={styles.footerStatus}>
                    {plan.changes.length === 0
                      ? ''
                      : unresolved.length > 0
                        ? `${unresolved.length} conflict${unresolved.length === 1 ? '' : 's'} still need${unresolved.length === 1 ? 's' : ''} a decision.`
                        : `Merging writes ${changeCountLabel} to main's draft.`}
                  </span>
                  {open && (
                    <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={() => setDialog('decline')} data-testid="review-decline-open">
                      Decline…
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    type="button"
                    busy={busy}
                    disabled={busy || plan.changes.length === 0 || unresolved.length > 0}
                    tooltip={plan.changes.length === 0 ? 'Nothing to merge' : unresolved.length > 0 ? `${unresolved.length} conflict${unresolved.length === 1 ? '' : 's'} still need a decision` : undefined}
                    onClick={() => { void merge() }}
                    data-testid="review-merge"
                  >
                    <GitMergeSolidIcon size={12} aria-hidden="true" />
                    <span>Merge {changeCountLabel}</span>
                  </Button>
                </>
              ) : open ? (
                <>
                  <span className={styles.footerStatus}>Waiting for a branch manager to review.</span>
                  {request.requestedBy?.id === user.id && (
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      busy={busy}
                      onClick={() => { void withBusy('withdraw the request', () => data.withdraw()) }}
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
                        ? 'This branch was merged.'
                        : 'Request a merge when the branch is ready for review.'}
                  </span>
                  {request?.status !== 'merged' && (
                    <Button variant="primary" size="sm" type="button" disabled={busy} onClick={() => setDialog('request')} data-testid="review-request-open">
                      {request?.status === 'declined' ? 'Request merge again…' : 'Request merge…'}
                    </Button>
                  )}
                </>
              )}
            </footer>
          </div>

          {dialog === 'request' && (
            <NoteDialog
              eyebrow="Request a merge"
              title={`Ask to merge ${branchName} into main`}
              hint="Say what changed and why. A branch manager reads the changes below and merges or declines."
              placeholder="What is in this branch?"
              confirmLabel="Send request"
              required={false}
              busy={busy}
              onClose={() => setDialog(null)}
              onConfirm={async (note) => {
                const done = await withBusy('request the merge', () => data.request(note))
                if (done) setDialog(null)
              }}
              testId="review-request"
            />
          )}
          {dialog === 'decline' && request && (
            <NoteDialog
              eyebrow="Decline"
              title={`What should ${request.requestedBy?.displayName ?? 'the requester'} change?`}
              hint="The note is what the requester sees. Say what to fix."
              placeholder="Required"
              confirmLabel="Decline with note"
              required
              tone="danger"
              busy={busy}
              onClose={() => setDialog(null)}
              onConfirm={async (note) => {
                const done = await withBusy('decline the request', () => data.decline(note))
                if (done) setDialog(null)
              }}
              testId="review-decline"
            />
          )}
        </div>
      )}
    />
  )
}

function threadPlaceholder(change: MergeChange): string {
  if (isPageChange(change)) return 'Comment on this page'
  if (change.kind === 'row') return 'Comment on this entry'
  if (change.kind === 'table') return 'Comment on this table'
  if (change.kind === 'file') return 'Comment on this file'
  return 'Comment on these settings'
}

function StatusPill({ status, unresolved }: { status: 'open' | 'declined' | 'merged' | 'withdrawn'; unresolved: number }) {
  const label = status === 'open' && unresolved > 0
    ? `${requestStatusLabel(status)} · ${unresolved} conflict${unresolved === 1 ? '' : 's'}`
    : requestStatusLabel(status)
  return (
    <span className={styles.statusPill} data-tone={requestStatusTone(status)} data-testid="review-status">
      {label}
    </span>
  )
}

interface TimelineNodeProps {
  id: string
  marker: React.ReactNode
  left: React.ReactNode
  right: React.ReactNode
  last?: boolean
}

function TimelineNode({ id, marker, left, right, last = false }: TimelineNodeProps) {
  return (
    <div id={id} className={styles.node} data-last={last ? 'true' : 'false'}>
      <span className={styles.marker}>{marker}</span>
      <div className={styles.left}>{left}</div>
      <div className={styles.right}>{right}</div>
    </div>
  )
}

interface NoteDialogProps {
  eyebrow: string
  title: string
  hint: string
  placeholder: string
  confirmLabel: string
  required: boolean
  tone?: 'danger'
  busy: boolean
  onClose: () => void
  onConfirm: (note: string) => Promise<void>
  testId: string
}

function NoteDialog({ eyebrow, title, hint, placeholder, confirmLabel, required, tone, busy, onClose, onConfirm, testId }: NoteDialogProps) {
  const [note, setNote] = useState('')
  const canConfirm = !busy && (!required || note.trim().length > 0)
  return (
    <Dialog
      open
      size="md"
      tone={tone}
      onClose={busy ? () => {} : onClose}
      eyebrow={eyebrow}
      title={title}
      footer={(
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'destructive' : 'primary'}
            size="sm"
            type="button"
            busy={busy}
            disabled={!canConfirm}
            onClick={() => { void onConfirm(note) }}
            data-testid={`${testId}-confirm`}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <div className={styles.dialogBody}>
        <p className={styles.dialogHint}>{hint}</p>
        <Textarea
          fieldSize="sm"
          rows={4}
          autoFocus
          placeholder={placeholder}
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
          data-testid={`${testId}-note`}
        />
      </div>
    </Dialog>
  )
}
