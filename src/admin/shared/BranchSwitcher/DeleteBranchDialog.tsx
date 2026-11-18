/**
 * Confirm deleting a branch. Deletion discards every unmerged change on the
 * branch, so it always confirms (independent of the "confirm before delete"
 * editor preference) and runs through step-up — the server re-verifies the
 * actor before dropping the rows.
 */
import { useState } from 'react'
import type { SiteBranch } from '@core/branches'
import { getErrorMessage } from '@core/utils/errorMessage'
import { deleteBranch } from '@admin/state/branchStore'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { pushToast } from '@ui/components/Toast'

interface DeleteBranchDialogProps {
  branch: SiteBranch
  onClose: () => void
}

export function DeleteBranchDialog({ branch, onClose }: DeleteBranchDialogProps) {
  const { runStepUp } = useStepUp()
  const [busy, setBusy] = useState(false)

  async function confirmDelete(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await runStepUp(() => deleteBranch(branch.id))
      onClose()
      pushToast({ kind: 'success', title: `Deleted ${branch.name}` })
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      console.error('[branches] delete failed:', err)
      pushToast({ kind: 'error', title: 'Could not delete branch', body: getErrorMessage(err, 'Unknown branch error') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      tone="danger"
      eyebrow="Delete branch"
      title={`Delete ${branch.name}?`}
      size="sm"
      footer={(
        <>
          <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            type="button"
            busy={busy}
            onClick={() => { void confirmDelete() }}
            data-testid="branch-delete-confirm"
          >
            Delete branch
          </Button>
        </>
      )}
    >
      <p>
        Every change made on <strong>{branch.name}</strong> that has not been merged into main is
        discarded. Preview links for the branch stop working. This cannot be undone.
      </p>
    </Dialog>
  )
}
